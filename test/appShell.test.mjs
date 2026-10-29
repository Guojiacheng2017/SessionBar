import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

test("all application pages use the shared shell instead of owning header copies", async () => {
  for (const [page, entry] of [["index", "app"]]) {
    const html = await readFile(new URL(`../public/${page}.html`, import.meta.url), "utf8");
    const source = await readFile(new URL(`../src/web/${entry}.ts`, import.meta.url), "utf8");
    assert.match(html, /class="app-shell(?:\s[^\"]*)?"/, page);
    assert.match(html, /<header class="app-header" data-app-header><\/header>/, page);
    assert.doesNotMatch(html, /class="app-nav"|id="port"/, `${page} must not own header markup`);
    assert.match(source, /import \{ mountAppHeader \} from "\.\/appShell\.js"/, page);
  }
});

test("shared header selects exactly one navigation item and preserves real links", async () => {
  const source = await readFile(new URL("../src/web/appShell.ts", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022 } });
  const { appHeaderMarkup } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
  for (const [page, href] of [["dashboard", "./"]]) {
    const html = appHeaderMarkup(page);
    assert.equal((html.match(/aria-current="page"/g) || []).length, 1);
    assert.match(html, new RegExp(`href="${href.replaceAll(".", "\\.")}" aria-current="page"`));
    assert.match(html, /aria-label="Application"/);
    assert.equal((html.match(/id="port"/g) || []).length, 1);
    assert.match(html, /sessionbar-wordmark\.svg/);
    assert.doesNotMatch(html, /settings\.html|devices\.html|pair\.html/);
  }
});
