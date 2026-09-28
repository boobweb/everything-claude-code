---
type: regex
pattern: '^''use strict'';\nconst util = require\(''\./util\.cjs''\);\n\n/\*\* Create the application state\. \*/\nfunction createState\(opts = \{\}\) \{[\s\S]*module\.exports = \{ createState, loadData, Store, render \};\n$'
target:
  source: file
  path: src/app.js
---
