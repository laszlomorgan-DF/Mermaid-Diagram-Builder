# Your real SQL goes here

Drop schema exports here, for example:

- `schema.sql` from SSMS *Generate Scripts* (schema only), `pg_dump --schema-only`, or `mysqldump --no-data`
- `catalog.tsv` / `catalog.csv`: the result of the query in the tool's **Verify** tab, run on the same database

Then either open them in `dist/SQL-ER-Diagram-Builder.html`, or run:

```
npm run report -- samples/schema.sql
```
