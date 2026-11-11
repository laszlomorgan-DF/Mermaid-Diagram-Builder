\restrict AbCdEf123
-- Hand-written PostgreSQL with a few traps.
/* outer /* nested */ still a comment; not a statement */
CREATE TYPE mood AS ENUM ('happy', 'sad');

CREATE TABLE IF NOT EXISTS Users (
    UserId serial PRIMARY KEY,
    "Email" text NOT NULL,
    Nick varchar(40),
    mood mood DEFAULT 'happy',
    note text DEFAULT E'it''s; fine\n',
    created timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE profiles (
    user_id integer PRIMARY KEY REFERENCES users ON DELETE CASCADE,
    bio text
);

CREATE TABLE "Teams" (
    id bigint GENERATED ALWAYS AS IDENTITY,
    name text NOT NULL,
    lead_user_id integer,
    CONSTRAINT teams_pk PRIMARY KEY (id),
    CONSTRAINT teams_lead_fk FOREIGN KEY (lead_user_id) REFERENCES users (userid) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE team_members (
    team_id bigint NOT NULL REFERENCES "Teams"(id),
    user_id integer NOT NULL,
    role text,
    legacy_flag boolean,
    PRIMARY KEY (team_id, user_id)
);

ALTER TABLE team_members ADD CONSTRAINT team_members_user_fk FOREIGN KEY (user_id) REFERENCES users(userid);
ALTER TABLE team_members RENAME COLUMN role TO member_role;
ALTER TABLE team_members DROP COLUMN legacy_flag;
ALTER TABLE team_members ADD COLUMN joined_on date NOT NULL DEFAULT current_date;
ALTER TABLE profiles ALTER COLUMN bio SET NOT NULL;
CREATE UNIQUE INDEX users_email_lower ON users (lower("Email"));

COPY users (userid, "Email") FROM stdin;
1	a@example.com
2	b;still data@example.com
\.

CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $fn$ SELECT 1; $fn$;
CREATE TABLE measurements (city_id int NOT NULL, logdate date NOT NULL) PARTITION BY RANGE (logdate);
CREATE TABLE measurements_y2026 PARTITION OF measurements FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
GRANT SELECT ON ALL TABLES IN SCHEMA public TO reporting;
THIS IS NOT SQL AT ALL;
\unrestrict AbCdEf123
