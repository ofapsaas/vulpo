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
  function globToRegexSource(glob) {
    let out = "";
    for (let i = 0; i < glob.length; i++) {
      const c = glob[i];
      if (c === "*") {
        if (glob[i + 1] === "*") {
          out += ".*";
          i++;
        } else {
          out += "[^/]*";
        }
      } else if ("\\^$.|?+()[]{}".includes(c)) {
        out += "\\" + c;
      } else {
        out += c;
      }
    }
    return out;
  }
  function globRegex(glob) {
    return new RegExp("^" + globToRegexSource(glob) + "$");
  }
  function parsePattern(token) {
    if (token === "**") return { catchAll: true, host: null, path: null };
    if (token === "*") return null;
    const slash = token.indexOf("/");
    const hostPart = slash === -1 ? token : token.slice(0, slash);
    const rawPath = slash === -1 ? null : token.slice(slash + 1);
    const host = parseHost(hostPart);
    if (host === null) return null;
    let path = null;
    if (rawPath !== null) {
      path = parsePath(rawPath);
      if (path === null) return null;
    }
    return { catchAll: false, host, path };
  }
  function parseHost(hostPart) {
    if (hostPart === "") return null;
    for (const label of hostPart.split(".")) {
      if (label === "") return null;
      if (!/^[A-Za-z0-9*-]+$/.test(label)) return null;
      if (label.startsWith("-") || label.endsWith("-")) return null;
    }
    const lower = hostPart.toLowerCase();
    if (!/[a-z0-9]/.test(lower)) return null;
    if (lower.startsWith("*.") && !lower.slice(2).includes("*")) {
      return { kind: "wild", suffix: lower.slice(2) };
    }
    if (lower.includes("*")) return { kind: "glob", source: lower };
    return { kind: "exact", v: lower };
  }
  function parsePath(rawPath) {
    const p = rawPath.replace(/^\/+|\/+$/g, "");
    if (p === "") return null;
    for (const segment of p.split("/")) {
      if (!/^[^\s?#]+$/.test(segment)) return null;
    }
    return p;
  }
  function hostMatches(hostname, host) {
    if (host.kind === "wild") {
      return hostname === host.suffix || hostname.endsWith("." + host.suffix);
    }
    if (host.kind === "exact") return hostname === host.v;
    return globRegex(host.source).test(hostname);
  }
  function pathMatches(pathname, path) {
    if (path === null) return true;
    return new RegExp("^" + globToRegexSource("/" + path) + "(/.*)?$").test(pathname);
  }
  function hostCoveredBy(h, pat) {
    if (pat.kind === "wild") return h === pat.suffix || h.endsWith("." + pat.suffix);
    if (pat.kind === "glob") return globRegex(pat.source).test(h);
    if (pat.kind === "exact") return h === pat.v;
    return false;
  }
  function literalPrefix(s) {
    const i = s.indexOf("*");
    return i === -1 ? s : s.slice(0, i);
  }
  function literalSuffix(s) {
    const i = s.lastIndexOf("*");
    return i === -1 ? s : s.slice(i + 1);
  }
  function hostLiteralParts(host) {
    if (host.kind === "exact") return { prefix: host.v, suffix: host.v };
    if (host.kind === "wild") return { prefix: "", suffix: host.suffix };
    return { prefix: literalPrefix(host.source), suffix: literalSuffix(host.source) };
  }
  function globHostsMayOverlap(a, b) {
    const { prefix: pa, suffix: sa } = hostLiteralParts(a);
    const { prefix: pb, suffix: sb } = hostLiteralParts(b);
    const prefixOk = pa === "" || pb === "" || pa.startsWith(pb) || pb.startsWith(pa);
    const suffixOk = sa === "" || sb === "" || sa.endsWith(sb) || sb.endsWith(sa);
    return prefixOk && suffixOk;
  }
  function hostsOverlap(a, b) {
    if (a.kind === "exact" && b.kind === "exact") return a.v === b.v;
    if (a.kind === "exact") return hostCoveredBy(a.v, b);
    if (b.kind === "exact") return hostCoveredBy(b.v, a);
    if (a.kind === "wild" && b.kind === "wild") {
      return a.suffix === b.suffix || a.suffix.endsWith("." + b.suffix) || b.suffix.endsWith("." + a.suffix);
    }
    return globHostsMayOverlap(a, b);
  }
  function pathsOverlap(a, b) {
    if (a === null || b === null) return true;
    if (a === b) return true;
    if (a.includes("*") || b.includes("*")) {
      const pa = literalPrefix(a);
      const pb = literalPrefix(b);
      return pa === pb || pa.startsWith(pb) || pb.startsWith(pa);
    }
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
    const warnings = [];
    const warn = (code, line, message, detail) => warnings.push({ code, line, message, detail });
    const rawLines = String(text).split("\n");
    const byId = /* @__PURE__ */ new Map();
    const profiles = [];
    const scoped = [];
    let catchAllTaken = false;
    for (let i = 0; i < rawLines.length; i++) {
      const line = rawLines[i].trim();
      const lineNo = i + 1;
      if (!line || line.startsWith("#")) continue;
      const parts = line.split(/\s+/);
      if (parts.length === 2 && parts[0] === "*" && parts[1] === "None") continue;
      if (parts.length < 3) {
        warn("invalid_line", lineNo, `invalid rules line "${line}": expected "bridgeUrl token domain1 domain2 ..."`, line);
        continue;
      }
      const bridgeUrl = parts[0].replace(/\/+$/, "");
      const token = parts[1];
      if (!isValidUrl(bridgeUrl)) {
        warn("invalid_line", lineNo, `invalid bridge URL "${parts[0]}" in rules line "${line}"`, parts[0]);
        continue;
      }
      const id = `${bridgeUrl}|${token}`;
      if (byId.has(id)) {
        warn("duplicate_id", lineNo, `duplicate profile id "${id}" \u2014 first-wins: se ignora la l\xEDnea posterior`, id);
        continue;
      }
      let domains = [];
      for (const domain of parts.slice(2)) {
        const pattern = parsePattern(domain);
        if (pattern === null) {
          warn("invalid_domain", lineNo, `invalid domain "${domain}" (line "${line}") \u2014 token descartado`, domain);
          continue;
        }
        domains.push(domain);
        if (!pattern.catchAll && isBroadGlob(pattern.host)) {
          warn("broad_glob", lineNo, `broad host glob "${domain}" (line "${line}") \u2014 el perfil carga tal cual; revis\xE1 el alcance`, domain);
        }
      }
      const catchCount = domains.filter((d) => d === "**").length;
      const scopedDomains = domains.filter((d) => d !== "**");
      if (catchCount > 0 && (scopedDomains.length > 0 || catchCount > 1)) {
        warn("catch_all_conflict", lineNo, `"**" must be the only domain of profile "${id}" \u2014 se ignora el catch-all`, id);
        domains = scopedDomains.length > 0 ? scopedDomains : ["**"];
      }
      if (domains.length === 0) {
        warn("invalid_line", lineNo, `rules line "${line}" has no valid domain \u2014 se saltea la l\xEDnea`, line);
        continue;
      }
      if (domains.length === 1 && domains[0] === "**") {
        if (catchAllTaken) {
          warn("catch_all_conflict", lineNo, `at most one "**" catch-all profile is allowed \u2014 se ignora "${id}"`, id);
          continue;
        }
        catchAllTaken = true;
      }
      const profile = { id, bridgeUrl, token, domains: [...domains] };
      byId.set(id, profile);
      profiles.push(profile);
      if (!domains.includes("**")) {
        scoped.push({ id, line: lineNo, patterns: domains.map(parsePattern).filter(Boolean) });
      }
    }
    for (let i = 0; i < scoped.length; i++) {
      for (let j = i + 1; j < scoped.length; j++) {
        for (const a of scoped[i].patterns) {
          for (const b of scoped[j].patterns) {
            if (patternsOverlap(a, b)) {
              warn(
                "overlap",
                scoped[j].line,
                `overlapping domains between profiles "${scoped[i].id}" and "${scoped[j].id}" \u2014 first-match wins: "${scoped[i].id}" prevalece`,
                `${scoped[i].id} < ${scoped[j].id}`
              );
            }
          }
        }
      }
    }
    warnings.sort((a, b) => a.line - b.line);
    return { ok: true, profiles, warnings };
  }
  function isValidUrl(str) {
    try {
      const u = new URL(str);
      return u.protocol === "http:" || u.protocol === "https:";
    } catch {
      return false;
    }
  }
  function isBroadGlob(host) {
    if (host.kind !== "glob") return false;
    return host.source.split(".")[0].startsWith("*");
  }
  return __toCommonJS(rules_exports);
})();
