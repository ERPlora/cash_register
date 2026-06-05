-- Cash Register · esquema inicial (SQLite). Portado de old_modules/m_cash_register/models.py (v1.2.6).
-- Modelos: CashRegisterSettings, CashRegister, CashSession, CashMovement, CashCount.
-- Reconciliación: expected = opening + sum(movements); difference = closing - expected.
-- Contrato §2.5: hub_id + soft-delete + auditoría.

CREATE TABLE IF NOT EXISTS cash_register_settings (
    id                          TEXT PRIMARY KEY,
    hub_id                      TEXT NOT NULL,
    enable_cash_register        INTEGER NOT NULL DEFAULT 1,
    require_opening_balance     INTEGER NOT NULL DEFAULT 0,
    require_closing_balance     INTEGER NOT NULL DEFAULT 1,
    allow_negative_balance      INTEGER NOT NULL DEFAULT 0,
    auto_open_session_on_login  INTEGER NOT NULL DEFAULT 1,
    auto_close_session_on_logout INTEGER NOT NULL DEFAULT 1,
    protected_pos_url           TEXT NOT NULL DEFAULT '/m/sales/pos/',
    is_deleted INTEGER NOT NULL DEFAULT 0, deleted_at TEXT,
    created_by TEXT, updated_by TEXT, created_at TEXT, updated_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_cashreg_settings_hub ON cash_register_settings (hub_id);

CREATE TABLE IF NOT EXISTS cash_register_register (
    id        TEXT PRIMARY KEY,
    hub_id    TEXT NOT NULL,
    name      TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    is_deleted INTEGER NOT NULL DEFAULT 0, deleted_at TEXT,
    created_by TEXT, updated_by TEXT, created_at TEXT, updated_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_cashreg_hub ON cash_register_register (hub_id, is_active);

CREATE TABLE IF NOT EXISTS cash_register_session (
    id               TEXT PRIMARY KEY,
    hub_id           TEXT NOT NULL,
    user_id          TEXT NOT NULL,
    register_id      TEXT,
    session_number   TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'open',   -- open|closed|suspended
    opened_at        TEXT,
    opening_balance  NUMERIC NOT NULL DEFAULT 0,
    opening_notes    TEXT NOT NULL DEFAULT '',
    closed_at        TEXT,
    closing_balance  NUMERIC,
    expected_balance NUMERIC,
    difference       NUMERIC,
    closing_notes    TEXT NOT NULL DEFAULT '',
    is_deleted INTEGER NOT NULL DEFAULT 0, deleted_at TEXT,
    created_by TEXT, updated_by TEXT, created_at TEXT, updated_at TEXT,
    FOREIGN KEY (register_id) REFERENCES cash_register_register (id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS ix_cashsession_hub_status ON cash_register_session (hub_id, status);
CREATE INDEX IF NOT EXISTS ix_cashsession_user       ON cash_register_session (hub_id, user_id, status);

CREATE TABLE IF NOT EXISTS cash_register_movement (
    id             TEXT PRIMARY KEY,
    hub_id         TEXT NOT NULL,
    session_id     TEXT NOT NULL,
    movement_type  TEXT NOT NULL,           -- sale|refund|in|out
    amount         NUMERIC NOT NULL DEFAULT 0,
    payment_method TEXT NOT NULL DEFAULT 'cash',
    sale_reference TEXT NOT NULL DEFAULT '',
    description    TEXT NOT NULL DEFAULT '',
    employee_id    TEXT,
    is_deleted INTEGER NOT NULL DEFAULT 0, deleted_at TEXT,
    created_by TEXT, updated_by TEXT, created_at TEXT, updated_at TEXT,
    FOREIGN KEY (session_id) REFERENCES cash_register_session (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ix_cashmovement_session ON cash_register_movement (hub_id, session_id);

CREATE TABLE IF NOT EXISTS cash_register_count (
    id            TEXT PRIMARY KEY,
    hub_id        TEXT NOT NULL,
    session_id    TEXT NOT NULL,
    count_type    TEXT NOT NULL,            -- opening|closing
    denominations TEXT NOT NULL DEFAULT '{}',
    total         NUMERIC NOT NULL DEFAULT 0,
    notes         TEXT NOT NULL DEFAULT '',
    counted_at    TEXT,
    is_deleted INTEGER NOT NULL DEFAULT 0, deleted_at TEXT,
    created_by TEXT, updated_by TEXT, created_at TEXT, updated_at TEXT,
    FOREIGN KEY (session_id) REFERENCES cash_register_session (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ix_cashcount_session ON cash_register_count (hub_id, session_id);
