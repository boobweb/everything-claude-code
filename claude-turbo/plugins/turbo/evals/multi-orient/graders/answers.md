---
type: llm
weight: 2
---

PASS only if all three answers are correct: (1) the question bank is data/questions.json with 40 questions; (2) Store.save is an async method that returns true (a Promise resolving to true); (3) the list of question objects is built by the make method of the Generator class in tools/gen.py. FAIL if any answer is wrong, missing, or names a different file, method or count.
