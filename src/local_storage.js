const path = require('node:path')

const xdg = require('xdg-portable/cjs')
const { JSONFilePreset } = require('lowdb/node')

let _db

module.exports.getDb = async () => {
  if (_db) return _db

  const configDir = path.join(xdg.configDir(), '.static-chic')
  _db = await new JSONFilePreset(configDir, {})
}
