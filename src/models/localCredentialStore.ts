// Local account persistence: AES-256-GCM, with a host-only 0600 master key.
// This protects stored DB/export contents; it is not isolation from the host OS account.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import type { Db } from '../storage/db.js';
import { ApiError } from '../../contracts/errors.js';
interface CredentialRow { nonce: string; ciphertext: string; auth_tag: string }
export class LocalCredentialStore {
  constructor(private readonly db: Db, private readonly keyPath: string) {}
  private owner(sessionId: string): { userId: string; expiresAt: string } | undefined {
    return this.db.db.prepare(`SELECT s.user_id AS userId,s.expires_at AS expiresAt FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE s.id=? AND s.revoked_at IS NULL AND s.expires_at>? AND u.disabled=0`).get(sessionId,new Date().toISOString()) as {userId:string;expiresAt:string}|undefined;
  }
  private access(sessionId: string, configId: string) {
    const owner=this.owner(sessionId);
    return owner&&this.db.db.prepare('SELECT 1 FROM model_configs WHERE id=? AND owner_user_id=? AND enabled=1').get(configId,owner.userId)?owner:undefined;
  }
  private master(create: boolean): Buffer {
    if(!existsSync(this.keyPath)) {
      if(!create||this.db.db.prepare('SELECT 1 FROM local_model_credentials UNION ALL SELECT 1 FROM local_search_credentials LIMIT 1').get()) throw new ApiError('CREDENTIAL_REQUIRED','本机密钥文件缺失，请恢复备份或清除已存 Key 后重新设置');
      writeFileSync(this.keyPath,randomBytes(32),{flag:'wx',mode:0o600});
    }
    chmodSync(this.keyPath,0o600);
    const value=readFileSync(this.keyPath);
    if(value.length!==32)throw new ApiError('CREDENTIAL_REQUIRED','本机密钥文件不可用，请恢复备份');
    return value;
  }
  read(sessionId: string, configId: string): {key:string;expiresAt:string}|undefined {
    const owner=this.access(sessionId,configId);if(!owner)return;
    const row=this.db.db.prepare('SELECT nonce,ciphertext,auth_tag FROM local_model_credentials WHERE config_id=? AND owner_user_id=?').get(configId,owner.userId) as CredentialRow|undefined;
    if(!row)return;
    try {
      const decipher=createDecipheriv('aes-256-gcm',this.master(false),Buffer.from(row.nonce,'base64'));
      decipher.setAAD(Buffer.from(`${owner.userId}:${configId}`));decipher.setAuthTag(Buffer.from(row.auth_tag,'base64'));
      return {key:Buffer.concat([decipher.update(Buffer.from(row.ciphertext,'base64')),decipher.final()]).toString('utf8'),expiresAt:owner.expiresAt};
    }catch{return undefined;} // Fail closed; do not delete/rekey unreadable records or expose crypto internals.
  }
  write(sessionId: string, configId: string, key: string): void {
    const owner=this.access(sessionId,configId);if(!owner)throw new ApiError('NOT_FOUND','接口不存在或登录已失效');
    const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.master(true),nonce);
    cipher.setAAD(Buffer.from(`${owner.userId}:${configId}`));
    const ciphertext=Buffer.concat([cipher.update(key,'utf8'),cipher.final()]);
    this.db.db.prepare(`INSERT INTO local_model_credentials(config_id,owner_user_id,nonce,ciphertext,auth_tag,updated_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(config_id) DO UPDATE SET nonce=excluded.nonce,ciphertext=excluded.ciphertext,auth_tag=excluded.auth_tag,updated_at=excluded.updated_at`)
      .run(configId,owner.userId,nonce.toString('base64'),ciphertext.toString('base64'),cipher.getAuthTag().toString('base64'),new Date().toISOString());
  }
  forget(sessionId: string, configId?: string): string[] {
    const owner=this.owner(sessionId);if(!owner)return [];
    const ids=(this.db.db.prepare('SELECT config_id FROM local_model_credentials WHERE owner_user_id=?').all(owner.userId) as {config_id:string}[]).map(r=>r.config_id).filter(id=>!configId||id===configId);
    this.db.tx(tx=>{for(const id of ids)tx.prepare('DELETE FROM local_model_credentials WHERE config_id=? AND owner_user_id=?').run(id,owner.userId);if(!configId)tx.prepare('DELETE FROM local_search_credentials WHERE owner_user_id=?').run(owner.userId);});
    return ids;
  }
  readSearch(userId: string): string|undefined {
    if(!this.db.db.prepare('SELECT 1 FROM users WHERE id=? AND disabled=0').get(userId))return;
    const row=this.db.db.prepare('SELECT nonce,ciphertext,auth_tag FROM local_search_credentials WHERE owner_user_id=?').get(userId) as CredentialRow|undefined;
    if(!row)return;
    try{const d=createDecipheriv('aes-256-gcm',this.master(false),Buffer.from(row.nonce,'base64'));d.setAAD(Buffer.from(`${userId}:web-search`));d.setAuthTag(Buffer.from(row.auth_tag,'base64'));return Buffer.concat([d.update(Buffer.from(row.ciphertext,'base64')),d.final()]).toString('utf8');}catch{return undefined;}
  }
  /** 引用场景读取模型配置 Key（联网搜索复用，按账号+配置；不要求登录会话——searchWebForUser 只有 userId）。 */
  readModel(userId: string, configId: string): string|undefined {
    if(!this.db.db.prepare('SELECT 1 FROM users WHERE id=? AND disabled=0').get(userId))return;
    if(!this.db.db.prepare('SELECT 1 FROM model_configs WHERE id=? AND owner_user_id=? AND enabled=1').get(configId,userId))return;
    const row=this.db.db.prepare('SELECT nonce,ciphertext,auth_tag FROM local_model_credentials WHERE config_id=? AND owner_user_id=?').get(configId,userId) as CredentialRow|undefined;
    if(!row)return;
    try{const d=createDecipheriv('aes-256-gcm',this.master(false),Buffer.from(row.nonce,'base64'));d.setAAD(Buffer.from(`${userId}:${configId}`));d.setAuthTag(Buffer.from(row.auth_tag,'base64'));return Buffer.concat([d.update(Buffer.from(row.ciphertext,'base64')),d.final()]).toString('utf8');}catch{return undefined;}
  }
  writeSearch(userId: string, key: string): void {
    if(!this.db.db.prepare('SELECT 1 FROM users WHERE id=? AND disabled=0').get(userId))throw new ApiError('NOT_FOUND','账号不存在');
    const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.master(true),nonce);cipher.setAAD(Buffer.from(`${userId}:web-search`));
    const encrypted=Buffer.concat([cipher.update(key,'utf8'),cipher.final()]);
    this.db.db.prepare(`INSERT INTO local_search_credentials(owner_user_id,nonce,ciphertext,auth_tag,updated_at) VALUES (?,?,?,?,?)
      ON CONFLICT(owner_user_id) DO UPDATE SET nonce=excluded.nonce,ciphertext=excluded.ciphertext,auth_tag=excluded.auth_tag,updated_at=excluded.updated_at`)
      .run(userId,nonce.toString('base64'),encrypted.toString('base64'),cipher.getAuthTag().toString('base64'),new Date().toISOString());
  }
  clearSearch(userId: string): void {this.db.db.prepare('DELETE FROM local_search_credentials WHERE owner_user_id=?').run(userId);}
  configChanged(configId: string): void { this.db.db.prepare('DELETE FROM local_model_credentials WHERE config_id=?').run(configId); }
}
