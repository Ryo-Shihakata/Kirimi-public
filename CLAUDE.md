# Kirimi

Kimono Labs 再現のセルフホスト型スクレイパー（Node 22 / Express 5 / better-sqlite3 / cheerio / Playwright）。ビルド工程なし、フロントは素のES Modules。

- 抽出は必ず `src/extract.js` を通す（プレビューと本番の一致が前提）
- `public/selector.js` が作るセレクタは cheerio でも同じ意味になる構文（タグ・クラス・`:nth-of-type`・`>`）に限る
- 行からの相対セレクタは「行の直下から」の意味（ブラウザ `:scope > sel` / cheerio `find('> sel')`）
- 変更後は `npm test`（E2E・MCP含む）→ `sudo systemctl restart kirimi`（dev-vmで常駐中）
- MCP サーバは `src/mcp.js`（user scope で登録済み）
