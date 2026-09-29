---
type: regex
pattern: 'function S\(id\) \{[\s\S]{0,300}document\.body\.dataset\.screen = id;[\s\S]{0,40}\}'
target:
  source: file
  path: index.html
weight: 4
---
