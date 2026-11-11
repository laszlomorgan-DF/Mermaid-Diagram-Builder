--
-- PostgreSQL database dump
--

-- Dumped from database version 16.4
-- Dumped by pg_dump version 16.4

SET statement_timeout = 0;
SET lock_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;

--
-- Name: billing; Type: SCHEMA; Schema: -; Owner: app
--

CREATE SCHEMA billing;


ALTER SCHEMA billing OWNER TO app;

--
-- Name: touch_updated(); Type: FUNCTION; Schema: public; Owner: app
--

CREATE FUNCTION public.touch_updated() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at := now(); -- semicolon inside a dollar-quoted body
  RETURN NEW;
END;
$$;


ALTER FUNCTION public.touch_updated() OWNER TO app;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: accounts; Type: TABLE; Schema: public; Owner: app
--

CREATE TABLE public.accounts (
    id integer NOT NULL,
    email character varying(255) NOT NULL,
    "Display Name" text,
    tags text[] DEFAULT '{}'::text[],
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone
);


ALTER TABLE public.accounts OWNER TO app;

--
-- Name: COLUMN accounts.email; Type: COMMENT; Schema: public; Owner: app
--

COMMENT ON COLUMN public.accounts.email IS 'Login email; must be unique';


--
-- Name: accounts_id_seq; Type: SEQUENCE; Schema: public; Owner: app
--

CREATE SEQUENCE public.accounts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.accounts_id_seq OWNER TO app;

ALTER SEQUENCE public.accounts_id_seq OWNED BY public.accounts.id;


--
-- Name: invoices; Type: TABLE; Schema: billing; Owner: app
--

CREATE TABLE billing.invoices (
    account_id integer NOT NULL,
    invoice_no integer NOT NULL,
    total numeric(12,2) DEFAULT 0 NOT NULL,
    currency character(3) DEFAULT 'EUR'::bpchar NOT NULL,
    issued_on date
);


ALTER TABLE billing.invoices OWNER TO app;

--
-- Name: invoice_lines; Type: TABLE; Schema: billing; Owner: app
--

CREATE TABLE billing.invoice_lines (
    account_id integer NOT NULL,
    invoice_no integer NOT NULL,
    line_no smallint NOT NULL,
    description text,
    amount numeric(12,2) NOT NULL,
    product_id bigint
);


ALTER TABLE billing.invoice_lines OWNER TO app;

--
-- Name: products; Type: TABLE; Schema: public; Owner: app
--

CREATE TABLE public.products (
    product_id bigint NOT NULL,
    sku character varying(32) NOT NULL,
    price double precision
);


ALTER TABLE public.products OWNER TO app;

--
-- Name: accounts id; Type: DEFAULT; Schema: public; Owner: app
--

ALTER TABLE ONLY public.accounts ALTER COLUMN id SET DEFAULT nextval('public.accounts_id_seq'::regclass);


--
-- Name: accounts accounts_email_key; Type: CONSTRAINT; Schema: public; Owner: app
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_email_key UNIQUE (email);


--
-- Name: accounts accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: app
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_pkey PRIMARY KEY (id);


--
-- Name: invoices invoices_pkey; Type: CONSTRAINT; Schema: billing; Owner: app
--

ALTER TABLE ONLY billing.invoices
    ADD CONSTRAINT invoices_pkey PRIMARY KEY (account_id, invoice_no);


--
-- Name: invoice_lines invoice_lines_pkey; Type: CONSTRAINT; Schema: billing; Owner: app
--

ALTER TABLE ONLY billing.invoice_lines
    ADD CONSTRAINT invoice_lines_pkey PRIMARY KEY (account_id, invoice_no, line_no);


--
-- Name: products products_pkey; Type: CONSTRAINT; Schema: public; Owner: app
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_pkey PRIMARY KEY (product_id);


--
-- Name: idx_invoices_issued; Type: INDEX; Schema: billing; Owner: app
--

CREATE INDEX idx_invoices_issued ON billing.invoices USING btree (issued_on);


--
-- Name: products_sku_uq; Type: INDEX; Schema: public; Owner: app
--

CREATE UNIQUE INDEX products_sku_uq ON public.products USING btree (sku);


--
-- Name: accounts trg_touch; Type: TRIGGER; Schema: public; Owner: app
--

CREATE TRIGGER trg_touch BEFORE UPDATE ON public.accounts FOR EACH ROW EXECUTE FUNCTION public.touch_updated();


--
-- Name: invoices invoices_account_id_fkey; Type: FK CONSTRAINT; Schema: billing; Owner: app
--

ALTER TABLE ONLY billing.invoices
    ADD CONSTRAINT invoices_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: invoice_lines invoice_lines_invoice_fkey; Type: FK CONSTRAINT; Schema: billing; Owner: app
--

ALTER TABLE ONLY billing.invoice_lines
    ADD CONSTRAINT invoice_lines_invoice_fkey FOREIGN KEY (account_id, invoice_no) REFERENCES billing.invoices(account_id, invoice_no);


--
-- PostgreSQL database dump complete
--

