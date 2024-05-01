import { env } from 'vscode';
import * as crypto from 'crypto';
import * as CryptoJS from 'crypto-js';

const algorithm = 'aes-256-cbc';
const keyLength = 32;
const saltLength = 16;
const ivLength = 16;

export class CryptoService {
    public static encrypt(text: string): string {
        const iv = crypto.randomBytes(ivLength);
        const salt = crypto.randomBytes(saltLength);
        const secretKey = crypto.scryptSync(env.machineId, salt, keyLength);

        const cipher = crypto.createCipheriv(algorithm, secretKey, iv);

        let encrypted = cipher.update(Buffer.from(text, "utf8"));
        encrypted = Buffer.concat([encrypted, cipher.final()]);

        return Buffer.from(JSON.stringify({
            iv: iv.toString('hex'),
            salt: salt.toString("hex"),
            text: encrypted.toString('hex')
        })).toString("base64");
    }

    public static decrypt(encrypted: string) {
        const data = JSON.parse(Buffer.from(encrypted, "base64").toString("utf-8"));
        const secretKey = crypto.scryptSync(env.machineId, Buffer.from(data.salt, "hex"), keyLength);

        const decipher = crypto.createDecipheriv(algorithm, secretKey, Buffer.from(data.iv, "hex"));

        let decrypted = decipher.update(Buffer.from(data.text, "hex"));
        decrypted = Buffer.concat([decrypted, decipher.final()]);

        return decrypted.toString("utf-8");
    }

    /**
     * @todo Remover essa função, e a lib crypto-js, após o período de adaptação para a nova criptogria
     */
    public static decryptOld(text: string) {
        return CryptoJS.AES.decrypt(text, env.machineId).toString(CryptoJS.enc.Utf8);
    }
}
