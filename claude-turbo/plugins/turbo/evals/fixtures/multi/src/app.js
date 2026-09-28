'use strict';
const util = require('./util.cjs');

/** Create the application state. */
function createState(opts = {}) {
  return { score: 0, level: opts.level || 1, items: [] };
}

async function loadData(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

class Store {
  constructor() { this.data = new Map(); }
  get(k) { return this.data.get(k); }
  set(k, v) { this.data.set(k, v); return this; }
  async save() { return true; }
}

const render = (state) => {
  return JSON.stringify(state);
};

module.exports = { createState, loadData, Store, render };
