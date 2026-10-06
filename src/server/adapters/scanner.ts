/**
 * Analyse antivirus des documents avant leur mise à disposition (US-34 RT2). Aucun antivirus réel
 * n'est branché : le détecteur de développement ne reconnaît que le fichier de test EICAR.
 */
export interface MalwareScanner {
  scan(content: Buffer): Promise<{ clean: boolean }>;
}

const EICAR = "X5O!P%@AP[4\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

export class DevScanner implements MalwareScanner {
  async scan(content: Buffer) {
    return { clean: !content.includes(EICAR) };
  }
}

let instance: MalwareScanner | undefined;

export function scanner(): MalwareScanner {
  instance ??= new DevScanner();
  return instance;
}

export const EICAR_TEST_STRING = EICAR;
