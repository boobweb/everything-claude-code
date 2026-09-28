---
type: regex
pattern: 'class Store \{[\s\S]*remove\(k\) \{ this\.data\.delete\(k\); return this; \}[\s\S]*\n\}'
target:
  source: file
  path: src/app.js
weight: 2
---
