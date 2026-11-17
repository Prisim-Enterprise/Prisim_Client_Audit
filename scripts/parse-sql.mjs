// =====================================================
// SQL syntax check without a database.
//
// Parses every migration and database test with libpg_query (the real
// PostgreSQL 17 parser), including the bodies of LANGUAGE sql functions and
// PL/pgSQL functions / DO blocks. It does not check that referenced objects
// exist; run the pgTAP suite against a local stack for semantics.
//
// Run: npm run sql:parse [files...]
// =====================================================
import pg from "libpg-query";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const { parse, parsePlPgSQL } = pg;
const root = process.cwd();
const defaults = ["supabase/migrations", "supabase/tests/database"].flatMap((dir) =>
  readdirSync(join(root, dir)).filter((name) => name.endsWith(".sql")).sort().map((name) => join(root, dir, name)),
);
const files = process.argv.length > 2 ? process.argv.slice(2) : defaults;
let failed = false;

for (const file of files) {
  const sql = readFileSync(file, "utf8");
  const label = relative(root, file);
  let tree;
  try {
    tree = await parse(sql);
  } catch (error) {
    failed = true;
    console.error(`FAIL ${label}: ${error.message}`);
    continue;
  }
  let bodies = 0;
  for (const { stmt, stmt_location = 0, stmt_len } of tree.stmts) {
    const text = sql.slice(stmt_location, stmt_len ? stmt_location + stmt_len : undefined);
    let language;
    let body;
    let name = "DO block";
    if (stmt.CreateFunctionStmt) {
      name = stmt.CreateFunctionStmt.funcname.map((part) => part.String.sval).join(".");
      for (const option of stmt.CreateFunctionStmt.options) {
        if (option.DefElem.defname === "language") language = option.DefElem.arg.String.sval;
        if (option.DefElem.defname === "as") body = option.DefElem.arg.List.items[0].String.sval;
      }
    } else if (stmt.DoStmt) {
      language = "plpgsql";
    } else {
      continue;
    }
    bodies++;
    try {
      if (language === "sql") await parse(body);
      else if (language === "plpgsql") await parsePlPgSQL(`${text};`);
    } catch (error) {
      failed = true;
      console.error(`FAIL ${label} ${name}: ${error.message}`);
    }
  }
  console.log(`ok   ${label} (${tree.stmts.length} statements, ${bodies} function bodies)`);
}
process.exit(failed ? 1 : 0);
