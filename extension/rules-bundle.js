var VulpoRules = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // rules.js
  var rules_exports = {};
  __export(rules_exports, {
    matchDomain: () => matchDomain,
    parseRules: () => parseRules,
    resolveProfile: () => resolveProfile
  });
  function parsePattern(token) {
    if (token === "**") return { catchAll: true, host: null, path: null };
    if (token === "*") return null;
    const slash = token.indexOf("/");
    const hostPart = slash === -1 ? token : token.slice(0, slash);
    const rawPath = slash === -1 ? null : token.slice(slash + 1);
    const wildcard = hostPart.startsWith("*.");
    const hostName = wildcard ? hostPart.slice(2) : hostPart;
    if (!isValidHost(hostName)) return null;
    const host = { t: wildcard ? "w" : "e", v: hostName.toLowerCase() };
    const path = rawPath === null ? null : rawPath.replace(/^\/+|\/+$/g, "") || null;
    return { catchAll: false, host, path };
  }
  function isValidHost(host) {
    return /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/.test(
      host
    );
  }
  function hostMatches(hostname, host) {
    if (host.t === "w") return hostname === host.v || hostname.endsWith("." + host.v);
    return hostname === host.v;
  }
  function pathMatches(pathname, prefix) {
    if (prefix === null) return true;
    const p = "/" + prefix;
    return pathname === p || pathname.startsWith(p + "/");
  }
  function exactInWildcard(h, suffix) {
    return h === suffix || h.endsWith("." + suffix);
  }
  function hostsOverlap(a, b) {
    if (a.t === "e" && b.t === "e") return a.v === b.v;
    if (a.t === "e") return exactInWildcard(a.v, b.v);
    if (b.t === "e") return exactInWildcard(b.v, a.v);
    return a.v === b.v || a.v.endsWith("." + b.v) || b.v.endsWith("." + a.v);
  }
  function pathsOverlap(a, b) {
    if (a === null || b === null) return true;
    if (a === b) return true;
    return a.startsWith(b + "/") || b.startsWith(a + "/");
  }
  function patternsOverlap(a, b) {
    return hostsOverlap(a.host, b.host) && pathsOverlap(a.path, b.path);
  }
  function matchDomain(url, pattern) {
    let u;
    try {
      u = new URL(url);
    } catch {
      return false;
    }
    if (!u.protocol.startsWith("http")) return false;
    const p = parsePattern(pattern);
    if (p === null) return false;
    if (p.catchAll) return true;
    return hostMatches(u.hostname, p.host) && pathMatches(u.pathname, p.path);
  }
  function resolveProfile(url, profiles) {
    let u;
    try {
      u = new URL(url);
    } catch {
      return null;
    }
    if (!u.protocol.startsWith("http")) return null;
    for (const profile of profiles) {
      for (const domain of profile.domains) {
        if (matchDomain(url, domain)) return profile;
      }
    }
    return null;
  }
  function parseRules(text) {
    const lines = String(text).split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    const byId = /* @__PURE__ */ new Map();
    const profiles = [];
    for (const line of lines) {
      const parts = line.split(/\s+/);
      if (parts.length === 2 && parts[0] === "*" && parts[1] === "None") continue;
      if (parts.length < 3) {
        return {
          ok: false,
          error: `invalid rules line "${line}": expected "bridgeUrl token domain1 domain2 ..."`
        };
      }
      const bridgeUrl = parts[0].replace(/\/+$/, "");
      const token = parts[1];
      const domains = parts.slice(2);
      if (!isValidUrl(bridgeUrl)) {
        return { ok: false, error: `invalid bridge URL "${parts[0]}" in rules line "${line}"` };
      }
      for (const domain of domains) {
        if (domain === "*") {
          return {
            ok: false,
            error: `invalid domain "*" (line "${line}") \u2014 use "**" for an explicit catch-all`
          };
        }
        if (parsePattern(domain) === null) {
          return { ok: false, error: `invalid domain "${domain}" (line "${line}") \u2014 not a valid host` };
        }
      }
      if (domains.includes("**") && domains.length > 1) {
        return { ok: false, error: `"**" must be the only domain of profile "${bridgeUrl}|${token}"` };
      }
      const id = `${bridgeUrl}|${token}`;
      if (byId.has(id)) {
        return { ok: false, error: `duplicate profile id "${id}"` };
      }
      const profile = { id, bridgeUrl, token, domains: [...domains] };
      byId.set(id, profile);
      profiles.push(profile);
    }
    const catchAlls = profiles.filter((p) => p.domains.includes("**"));
    if (catchAlls.length > 1) {
      return { ok: false, error: 'at most one "**" catch-all profile is allowed' };
    }
    const scoped = profiles.filter((p) => !p.domains.includes("**")).map((p) => ({ id: p.id, patterns: p.domains.map(parsePattern).filter(Boolean) }));
    for (let i = 0; i < scoped.length; i++) {
      for (let j = i + 1; j < scoped.length; j++) {
        for (const a of scoped[i].patterns) {
          for (const b of scoped[j].patterns) {
            if (patternsOverlap(a, b)) {
              return {
                ok: false,
                error: `overlapping domains between profiles "${scoped[i].id}" and "${scoped[j].id}"`
              };
            }
          }
        }
      }
    }
    return { ok: true, profiles };
  }
  function isValidUrl(str) {
    try {
      const u = new URL(str);
      return u.protocol === "http:" || u.protocol === "https:";
    } catch {
      return false;
    }
  }
  return __toCommonJS(rules_exports);
})();
