---
type: regex
pattern: '<script type="module">\nimport \{ clamp \} from ''\./src/util\.mjs'';\nexport const VERSION = ''3\.0\.0'';[\s\S]*</html>\s*$'
target:
  source: file
  path: index.html
---
