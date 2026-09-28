---
type: llm
---

PASS only if the answer lists exactly two occurrences: line 475 as a top-level declaration (the `let score = 0, combo = 0, hp = 100, bossHp = 100;` line) and line 518 inside the function uH (the HUD text update). FAIL if it lists other lines, misses one, or attributes a line to the wrong function.
