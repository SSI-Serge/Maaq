import { randomBytes } from "node:crypto";
import net from "node:net";
import { describe, expect, it, vi } from "vitest";
import { createSmtpTransport, MirroredMessenger, SmtpMessenger, type MailTransport } from "@/server/adapters/messaging/smtp";
import type { Messenger, OutgoingEmail, OutgoingSms } from "@/server/adapters/messaging";
import { parseEnv } from "@/server/env";

/** Messagerie qui mémorise ce qu'on lui donne, ou qui échoue à la demande. */
function recorder(options: { failEmail?: boolean } = {}) {
  const emails: OutgoingEmail[] = [];
  const sms: OutgoingSms[] = [];
  const messenger: Messenger = {
    async sendEmail(message) {
      if (options.failEmail) throw new Error("boîte indisponible");
      emails.push(message);
    },
    async sendSms(message) {
      sms.push(message);
    },
  };
  return { emails, sms, messenger };
}

const baseEnv = {
  DATABASE_URL: "postgres://u:p@localhost:5432/maaq",
  ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  HMAC_KEY: randomBytes(32).toString("base64"),
  AUTH_SECRET: randomBytes(32).toString("base64"),
  CRON_SECRET: "0123456789abcdef0123",
};

describe("envoi réel des emails (SMTP)", () => {
  it("l'email part avec l'expéditeur configuré, en texte brut, sans toucher au contenu", async () => {
    const sent: Parameters<MailTransport["sendMail"]>[0][] = [];
    const smtp = new SmtpMessenger({ sendMail: async (message) => void sent.push(message) }, "MAAQ <ne-pas-repondre@maaq.fr>", recorder().messenger);
    await smtp.sendEmail({ to: "camille@exemple.fr", subject: "Votre code MAAQ : 123456", text: "Bonjour Camille,\nVoici le code : 123456\nÀ très vite — l'équipe MAAQ" });
    expect(sent).toEqual([
      { from: "MAAQ <ne-pas-repondre@maaq.fr>", to: "camille@exemple.fr", subject: "Votre code MAAQ : 123456", text: "Bonjour Camille,\nVoici le code : 123456\nÀ très vite — l'équipe MAAQ" },
    ]);
  });

  it("un échec du serveur d'envoi remonte à l'appelant, qui décide quoi en faire", async () => {
    const smtp = new SmtpMessenger({ sendMail: async () => Promise.reject(new Error("535 identifiants refusés")) }, "MAAQ <a@maaq.fr>", recorder().messenger);
    await expect(smtp.sendEmail({ to: "x@exemple.fr", subject: "s", text: "t" })).rejects.toThrow("identifiants refusés");
  });

  it("les SMS ne partent pas : ils restent dans la boîte de test", async () => {
    const fallback = recorder();
    const smtp = new SmtpMessenger({ sendMail: async () => undefined }, "MAAQ <a@maaq.fr>", fallback.messenger);
    await smtp.sendSms({ to: "+33612345678", text: "Votre code : 654321" });
    expect(fallback.sms).toEqual([{ to: "+33612345678", text: "Votre code : 654321" }]);
  });
});

describe("zone de test : copie dans la boîte de test", () => {
  it("l'email part et une copie est déposée", async () => {
    const real = recorder();
    const copy = recorder();
    await new MirroredMessenger(real.messenger, copy.messenger).sendEmail({ to: "a@exemple.fr", subject: "s", text: "t" });
    expect(real.emails).toHaveLength(1);
    expect(copy.emails).toHaveLength(1);
  });

  it("une copie impossible ne fait pas échouer l'envoi", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const real = recorder();
    await new MirroredMessenger(real.messenger, recorder({ failEmail: true }).messenger).sendEmail({ to: "a@exemple.fr", subject: "s", text: "t" });
    expect(real.emails).toHaveLength(1);
  });

  it("si l'envoi réel échoue, l'erreur remonte (la copie, elle, existe)", async () => {
    const copy = recorder();
    const mirrored = new MirroredMessenger(recorder({ failEmail: true }).messenger, copy.messenger);
    await expect(mirrored.sendEmail({ to: "a@exemple.fr", subject: "s", text: "t" })).rejects.toThrow("indisponible");
    expect(copy.emails).toHaveLength(1);
  });

  it("les SMS passent par la messagerie principale, sans doublon", async () => {
    const real = recorder();
    const copy = recorder();
    await new MirroredMessenger(real.messenger, copy.messenger).sendSms({ to: "+33612345678", text: "code" });
    expect(real.sms).toHaveLength(1);
    expect(copy.sms).toHaveLength(0);
  });
});

describe("configuration de l'envoi", () => {
  it("par défaut, rien ne part : le mode « dev » n'exige aucun réglage d'envoi", () => {
    expect(parseEnv(baseEnv)).toMatchObject({ MESSAGING_MODE: "dev", SMTP_PORT: 587 });
  });

  it("le mode « smtp » exige serveur, identifiants et expéditeur, et nomme ce qui manque", () => {
    expect(() => parseEnv({ ...baseEnv, MESSAGING_MODE: "smtp" })).toThrow(/SMTP_HOST[\s\S]*SMTP_USER[\s\S]*SMTP_PASSWORD[\s\S]*MAIL_FROM/);
    expect(() => parseEnv({ ...baseEnv, MESSAGING_MODE: "smtp", SMTP_HOST: "smtp-relay.brevo.com", SMTP_USER: "u", SMTP_PASSWORD: "p" })).toThrow(/MAIL_FROM/);
  });

  it("une configuration complète est acceptée, le port est un nombre", () => {
    const parsed = parseEnv({ ...baseEnv, MESSAGING_MODE: "smtp", SMTP_HOST: "smtp-relay.brevo.com", SMTP_PORT: "587", SMTP_USER: "u", SMTP_PASSWORD: "p", MAIL_FROM: "MAAQ <ne-pas-repondre@maaq.fr>" });
    expect(parsed).toMatchObject({ MESSAGING_MODE: "smtp", SMTP_PORT: 587, MAIL_FROM: "MAAQ <ne-pas-repondre@maaq.fr>" });
  });

  it("un mode inconnu est refusé", () => {
    expect(() => parseEnv({ ...baseEnv, MESSAGING_MODE: "sendgrid" })).toThrow(/MESSAGING_MODE/);
  });
});

const CRLF = "\r\n";

/** Mini serveur SMTP : accepte une connexion, vérifie l'authentification et garde le message reçu. */
function fakeSmtpServer() {
  const received: { auth: string; from: string; to: string; data: string }[] = [];
  const server = net.createServer((socket) => {
    const mail = { auth: "", from: "", to: "", data: "" };
    let inData = false;
    let buffer = "";
    const reply = (line: string) => socket.write(line + CRLF);
    reply("220 test ESMTP");
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let index = buffer.indexOf(CRLF);
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + CRLF.length);
        index = buffer.indexOf(CRLF);
        if (inData) {
          if (line === ".") {
            inData = false;
            received.push({ ...mail });
            reply("250 OK");
          } else mail.data += line + "\n";
        } else if (/^EHLO/i.test(line)) socket.write("250-test" + CRLF + "250 AUTH PLAIN LOGIN" + CRLF);
        else if (/^AUTH PLAIN/i.test(line)) {
          mail.auth = Buffer.from(line.split(" ")[2] ?? "", "base64").toString("utf8").replaceAll("\u0000", "|");
          reply("235 OK");
        } else if (/^MAIL FROM/i.test(line)) {
          mail.from = line;
          reply("250 OK");
        } else if (/^RCPT TO/i.test(line)) {
          mail.to = line;
          reply("250 OK");
        } else if (/^DATA/i.test(line)) {
          inData = true;
          reply("354 go");
        } else if (/^QUIT/i.test(line)) {
          reply("221 bye");
          socket.end();
        } else reply("250 OK");
      }
    });
  });
  return new Promise<{ port: number; received: typeof received; close: () => void }>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as net.AddressInfo).port, received, close: () => server.close() })),
  );
}

describe("transport SMTP réel", () => {
  it("un email part par un vrai échange SMTP, authentifié, avec expéditeur, destinataire et lien", async () => {
    const server = await fakeSmtpServer();
    try {
      const transport = createSmtpTransport({ host: "127.0.0.1", port: server.port, user: "compte-brevo", password: "cle-smtp" });
      const smtp = new SmtpMessenger(transport, "MAAQ <ne-pas-repondre@maaq.fr>", recorder().messenger);
      await smtp.sendEmail({ to: "camille@exemple.fr", subject: "Activation de votre accès à MAAQ", text: "Bonjour Élodie,\nVoici votre lien : https://test.maaq.fr/activation?jeton=abc\n" });

      expect(server.received).toHaveLength(1);
      const [mail] = server.received;
      expect(mail.auth).toBe("|compte-brevo|cle-smtp");
      expect(mail.from).toContain("<ne-pas-repondre@maaq.fr>");
      expect(mail.to).toContain("<camille@exemple.fr>");
      expect(mail.data).toContain("MAAQ");
      expect(mail.data).toMatch(/Subject: /);
      // Le corps est encodé comme dans tout email (quoted-printable : « = » devient « =3D », lignes coupées par « = »).
      const decoded = mail.data.replace(/=\n/g, "").replace(/=([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
      expect(decoded).toContain("https://test.maaq.fr/activation?jeton=abc");
    } finally {
      server.close();
    }
  });

  it("un serveur injoignable fait échouer l'envoi plutôt que de le perdre en silence", async () => {
    const transport = createSmtpTransport({ host: "127.0.0.1", port: 1, user: "u", password: "p" });
    await expect(new SmtpMessenger(transport, "MAAQ <a@maaq.fr>", recorder().messenger).sendEmail({ to: "x@exemple.fr", subject: "s", text: "t" })).rejects.toThrow();
  });
});
