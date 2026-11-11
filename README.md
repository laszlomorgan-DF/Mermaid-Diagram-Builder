# SQL ER Diagram Builder

Turns database schema SQL (DDL) into a Mermaid `erDiagram`, and lets you add your own columns, tables and links without losing them when you re-import the SQL.

**To use it, open [dist/SQL-ER-Diagram-Builder.html](dist/SQL-ER-Diagram-Builder.html) in Edge or Chrome.** It is one file with no installs and no network access. You can copy it anywhere, for example to a share or a colleague.

## Workflow

1. **Get the SQL.** Use the export your database tool produces, not hand-copied snippets:
   - SQL Server: SSMS → right-click the database → Tasks → Generate Scripts (schema only).
   - PostgreSQL: `pg_dump --schema-only yourdb > schema.sql`
   - MySQL: `mysqldump --no-data yourdb > schema.sql`
2. **Open it.** Use *Open SQL…*, drop the file on the page, or paste it into the SQL tab. The dialect is detected automatically; set it yourself if the hint says it isn't sure.
3. **Read the Problems panel.** Every statement is accounted for:
   - **read:** turned into tables, columns or keys
   - **not structural:** e.g. `SET`, views, procedures, `INSERT`
   - **unread:** shown as a warning with its line number; click it to jump to that line

   Tick *Show every statement* to see the full log.
4. **Add your own items in the Tables tab.** Pick a table (or click it in the diagram), type a name and type, and press Enter. Optionally link the new column to another table's key. You can also create whole tables or keep a guessed link as a real one.

   These manual items are stored **separately** from the SQL. When you open a newer SQL export:
   - your items are kept
   - anything that now also exists in the SQL is flagged as a duplicate you can delete
   - anything whose table disappeared is kept and listed, not thrown away
5. **Verify against the database (Verify tab).** Copy the query shown, run it on the database, and paste the result. The tool compares tables, columns, nullability, primary, unique and foreign keys, and lists every difference. You can also use the result to fill in keys your SQL doesn't declare (marked "from catalog").
6. **Export:** `.mmd`, `.svg`, `.png`, the model as JSON, your **manual changes as `ALTER TABLE` SQL**, or the full schema as SQL.

   *Save project* stores the SQL, your manual changes and the view settings in one `.json` file. The browser also auto-saves, but treat the project file as the real copy.

## Reading the diagram

| Mark | Meaning |
|---|---|
| `PK` / `FK` / `UK` | primary key / foreign key / unique column |
| solid line | **identifying** link: the foreign key is part of the child table's primary key |
| dashed line | non-identifying link, or a **guess** (label starts with `guess:`) |
| `\|\|` vs `\|o` at the parent end | the FK columns are NOT NULL (exactly one parent) vs nullable (zero or one) |
| `o{` vs `o\|` at the child end | many children vs one-to-one (the FK columns are themselves unique) |
| `(manual)`, `"manual"` | added by you, not in the SQL |
| `(disabled)` | SQL Server `NOCHECK CONSTRAINT`: the key exists but isn't enforced |
| `(not in script)` | a foreign key points to a table the SQL doesn't define |
| `"SQL name: …"` | the real column name, when Mermaid can't display it as-is (spaces, `$`, `#`, …) |

**Guessed links** are only suggestions. They are made when a column such as `customer_id` or `CustomerID` matches another table's single-column primary key by name, **and** their types are compatible. They are never mixed up with declared keys, and can be switched off with the *Guessed links* checkbox.

## How it was checked

`npm run test:all` runs the following (Node is not required to *use* the tool, only to rebuild or test it):

| Check | What it proves |
|---|---|
| Hand-written expectations per sample (`tests/run-tests.js`, `FACTS`) | Specific tables, keys and statement counts, written by reading the SQL, not copied from the tool's output |
| Saved expected outputs (`tests/expected/*.model.json`, `*.mmd`) | Nothing changes unnoticed; refresh with `npm run test:update` *after reviewing the diff* |
| Round trip | SQL → model → generated SQL → model gives the identical model, for every sample |
| Second parser (node-sql-parser) | Where it can read a statement, its tables, columns and keys must agree with this tool's reading |
| Real PostgreSQL (PGlite) | The `pg_dump` sample loaded into Postgres, plus generated SQL for every sample: the database's own catalog must match the model exactly. A negative control confirms that differences get reported |
| Mermaid CLI (`npm run test:mmdc`) | Every saved diagram and a diagram exported from the UI render in `mmdc` without errors |
| Mermaid in the browser | Six display variants per sample, plus deliberately awkward names, render with the bundled Mermaid |
| UI run in headless Edge, network blocked (`npm run test:ui`) | Load, click-to-select, add columns from the keyboard, re-import conflicts, persistence, focus/filter, Verify, all exports (real PNG), dark mode, phone width, no console errors, no network requests |

## Your own files

Put real exports in [samples/](samples/), then run `npm run report -- samples/yourfile.sql`. It prints:
- the detected dialect and how sure it is
- every unread or partly read statement, with line numbers
- the cross-check result
- the guessed links

It also writes `samples/yourfile.mmd`.

To make one of them a permanent test case:
1. Copy it into `tests/fixtures/`.
2. Add a few hand-written expectations to `FACTS` in `tests/run-tests.js`.
3. Run `npm run test:update`, review the new files in `tests/expected/`, then run `npm test`.

## Known limits

- **Only table structure is read.** Views, procedures, functions and triggers are listed as not structural. SQL built at run time (`EXEC('…')`) and `CREATE TABLE … AS SELECT` / `PARTITION OF` are listed as unread.
- **Name matching ignores case**, as SQL Server and MySQL normally do. Unquoted PostgreSQL names are lowercased, as Postgres does. In Postgres, two tables that differ only by case (`"Foo"` and `foo`) would be merged.
- **Default schemas:** unqualified names are assigned to `dbo` (SQL Server) or `public` (PostgreSQL). MySQL tables have no schema unless the SQL names one.
- **Filtered unique indexes** (`… WHERE …`) count as unique keys, which can make a link show as one-to-one.
- **Untested catalog queries:** the SQL Server and MySQL queries in the Verify tab were written against the documented system views but have **not** been run on a real SQL Server or MySQL server. The PostgreSQL one has been run on a real Postgres. Run each once on your server; if one errors, the message will show what to fix.

## Development

- **Source files:**
  - `src/core.js`: parser, model, Mermaid/SQL output, catalog comparison; the same code runs in Node and the browser
  - `src/app.js`, `src/app.css`, `src/index.html`: the UI
  - `build.js`: inlines everything into `dist/`
- **Tools needed:** Node 20+. A portable copy was unzipped into `.tools/node/` for building and testing; delete that folder to remove it.
- **Commands:** `npm run build`, `npm test`, `npm run test:all`.
- **Libraries bundled into the HTML:** Mermaid 12.3.0 and node-sql-parser 5.4.0 (MIT). PGlite and mermaid-cli are used for testing only.
