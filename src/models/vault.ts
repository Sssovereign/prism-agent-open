import type { LocalCredentialStore } from './localCredentialStore.js';
/** Session-bound runtime cache; optional encrypted account store survives logout/restart. */
export class CredentialVault {
    constructor(private readonly store?: LocalCredentialStore) {}
    private entries = new Map<string, {
        sessionId: string; configId: string; key: string; expires: number;
        controllers: Set<AbortController>; timer: ReturnType<typeof setTimeout>;
    }>();
    private id(sessionId: string, configId: string) { return `${sessionId}:${configId}`; }
    private prune() { for (const [id, value] of this.entries) if (value.expires <= Date.now()) this.remove(id); }
    private remove(id: string) { const entry=this.entries.get(id);if(entry)clearTimeout(entry.timer);entry?.controllers.forEach(c=>c.abort());this.entries.delete(id); }
    private cache(sessionId: string, configId: string, key: string, expires: string) {
        const id=this.id(sessionId,configId);this.remove(id);const expiry=Date.parse(expires);
        // Node timers overflow above ~24.8 days; remembered sessions last 30 days.
        const schedule=():ReturnType<typeof setTimeout>=>{const timer=setTimeout(()=>{if(expiry<=Date.now())this.remove(id);else{const entry=this.entries.get(id);if(entry)entry.timer=schedule();}},Math.min(2_147_483_647,Math.max(0,expiry-Date.now())));timer.unref();return timer;};
        this.entries.set(id,{sessionId,configId,key,expires:expiry,controllers:new Set(),timer:schedule()});
    }
    set(sessionId: string, configId: string, key: string, expires: string) {
        this.prune();this.store?.write(sessionId,configId,key);
        // Key replacement invalidates every active cache for this account-owned config.
        this.configChanged(configId,false);this.cache(sessionId,configId,key,expires);
    }
    get(sessionId: string, configId: string) {
        this.prune();const id=this.id(sessionId,configId);
        if(this.store){const stored=this.store.read(sessionId,configId);if(!stored){this.remove(id);return undefined;}if(this.entries.get(id)?.key!==stored.key)this.cache(sessionId,configId,stored.key,stored.expiresAt);}
        return this.entries.get(id)?.key;
    }
    /** Logout clears only this session's runtime material, never account persistence. */
    clear(sessionId: string, configId?: string) { for(const [id,v]of this.entries)if(v.sessionId===sessionId&&(!configId||configId===v.configId))this.remove(id); }
    /** Explicit user deletion removes persistent credentials and all session caches. */
    forget(sessionId: string, configId?: string): string[] {
        const ids=this.store?.forget(sessionId,configId)??[];
        for(const id of ids)this.configChanged(id,false);
        this.clear(sessionId,configId);return ids;
    }
    configChanged(configId: string, clearKey: boolean) {
        if(clearKey)this.store?.configChanged(configId);
        for(const [id,v]of this.entries)if(v.configId===configId){v.controllers.forEach(c=>c.abort());if(clearKey)this.remove(id);}
    }
    track(sessionId: string, configId: string, c: AbortController) { const entry=this.entries.get(this.id(sessionId,configId));entry?.controllers.add(c);return()=>entry?.controllers.delete(c); }
    dispose() { for(const id of this.entries.keys())this.remove(id); }
}
