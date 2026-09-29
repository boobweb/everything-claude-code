---
type: llm
weight: 2
---

PASS only if the answer states all three of: (1) pickDisc stores its argument as the current discipline (assigns `disc`), (2) it sets the document's theme data attribute (documentElement.dataset.theme) to empty for "neuro" and to the discipline name otherwise, and (3) it switches to the mode screen by calling S('ms'). FAIL if any of the three is missing or if it describes behavior the function does not have.
