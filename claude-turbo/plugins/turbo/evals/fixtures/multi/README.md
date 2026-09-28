# Arena tools

Supporting code for the Arena quiz game.

## Layout

- `src/` application code (CommonJS entry in `src/app.js`, ESM helpers, a React widget, TypeScript types)
- `data/questions.json` the question bank
- `tools/` Python generators for question banks

## Running

`npm test`, `npm run lint`, `npm run build`. Generate a bank with `python tools/gen.py 40 > data/questions.json`.
