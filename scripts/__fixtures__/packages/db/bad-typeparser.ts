// FIXTURE: deliberately violates NO-PG-TYPE-PARSER.
import pg from 'pg';
pg.types.setTypeParser(1700, (v: string) => v);
