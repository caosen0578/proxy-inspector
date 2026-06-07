const { minimatch } = require('minimatch');
const fs = require('fs');
const path = require('path');

const RULES_FILE = path.join(__dirname, '..', 'rules.json');

class RuleEngine {
  constructor() {
    this.rules = [];
    this._load();
  }

  _load() {
    if (fs.existsSync(RULES_FILE)) {
      try {
        this.rules = JSON.parse(fs.readFileSync(RULES_FILE, 'utf8'));
      } catch {
        this.rules = [];
      }
    }
  }

  save() {
    fs.writeFileSync(RULES_FILE, JSON.stringify(this.rules, null, 2));
  }

  list() { return this.rules; }

  add(rule) {
    rule.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    rule.enabled = rule.enabled !== false;
    this.rules.push(rule);
    this.save();
    return rule;
  }

  update(id, patch) {
    const idx = this.rules.findIndex(r => r.id === id);
    if (idx === -1) return null;
    Object.assign(this.rules[idx], patch);
    this.save();
    return this.rules[idx];
  }

  remove(id) {
    const idx = this.rules.findIndex(r => r.id === id);
    if (idx === -1) return false;
    this.rules.splice(idx, 1);
    this.save();
    return true;
  }

  // 返回命中的第一条规则，未命中返回 null
  match(url, method) {
    for (const rule of this.rules) {
      if (!rule.enabled) continue;
      if (rule.method && rule.method !== '*' && rule.method !== method) continue;
      const pattern = rule.pattern || '';
      if (pattern.startsWith('/') && pattern.endsWith('/')) {
        // 正则模式
        try {
          if (new RegExp(pattern.slice(1, -1)).test(url)) return rule;
        } catch { /* ignore bad regex */ }
      } else if (minimatch(url, pattern, { matchBase: true })) {
        return rule;
      } else if (url.includes(pattern)) {
        return rule;
      }
    }
    return null;
  }
}

module.exports = new RuleEngine();
