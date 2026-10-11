import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LocalDrive } from "@/server/adapters/drive";
import { DevOutbox } from "@/server/adapters/messaging/dev-outbox";

describe("boîte de test des emails et SMS", () => {
  it("garde chaque message envoyé, du plus récent au plus ancien", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "maaq-outbox-"));
    const outbox = new DevOutbox(path.join(dir, "outbox.jsonl"));
    expect(await outbox.list()).toEqual([]);

    await outbox.sendEmail({ to: "camille@maaq.test", subject: "Votre code", text: "123456" });
    await outbox.sendSms({ to: "+33612345678", text: "Votre invitation MAAQ" });

    const messages = await outbox.list();
    expect(messages.map((m) => m.channel)).toEqual(["sms", "email"]);
    expect(messages[1]).toMatchObject({ to: "camille@maaq.test", subject: "Votre code", text: "123456" });
  });
});

describe("faux Google Drive", () => {
  const accountId = "6f1c1f4e-6c1d-4b8e-9a51-2a6f1f0b8c11";

  it("restitue un document déposé, avec son nom et son type", async () => {
    const drive = new LocalDrive(await mkdtemp(path.join(os.tmpdir(), "maaq-drive-")));
    const { fileId } = await drive.upload({
      accountId,
      fileName: "contrat-assurance.pdf",
      mimeType: "application/pdf",
      content: Buffer.from("%PDF-1.7 contenu"),
    });
    const file = await drive.read(accountId, fileId);
    expect(file.fileName).toBe("contrat-assurance.pdf");
    expect(file.mimeType).toBe("application/pdf");
    expect(file.content.toString()).toBe("%PDF-1.7 contenu");
  });

  it("refuse un identifiant qui sortirait du dossier du compte", async () => {
    const drive = new LocalDrive(await mkdtemp(path.join(os.tmpdir(), "maaq-drive-")));
    await expect(drive.read(accountId, "../../secret")).rejects.toThrow();
    await expect(drive.read("../autre", "6f1c1f4e-6c1d-4b8e-9a51-2a6f1f0b8c11")).rejects.toThrow();
  });
});
