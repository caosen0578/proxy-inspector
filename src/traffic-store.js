const { MAX_TRAFFIC_RECORDS } = require('./config');
const { EventEmitter } = require('events');

class TrafficStore extends EventEmitter {
  constructor() {
    super();
    this.records = [];
    this.idCounter = 0;
  }

  add(record) {
    record.id = ++this.idCounter;
    record.timestamp = Date.now();
    this.records.unshift(record);
    if (this.records.length > MAX_TRAFFIC_RECORDS) {
      this.records.length = MAX_TRAFFIC_RECORDS;
    }
    this.emit('record', record);
    return record;
  }

  update(id, patch) {
    const rec = this.records.find(r => r.id === id);
    if (rec) {
      Object.assign(rec, patch);
      this.emit('record-update', rec);
    }
    return rec;
  }

  list({ url, method, status, page = 1, size = 50 } = {}) {
    let items = this.records;
    if (url) items = items.filter(r => r.url && r.url.includes(url));
    if (method) items = items.filter(r => r.method === method.toUpperCase());
    if (status) items = items.filter(r => String(r.statusCode) === String(status));
    const total = items.length;
    const start = (page - 1) * size;
    return { total, page, size, items: items.slice(start, start + size) };
  }

  get(id) {
    return this.records.find(r => r.id === id);
  }

  clear() {
    this.records = [];
    this.emit('clear');
  }
}

module.exports = new TrafficStore();
