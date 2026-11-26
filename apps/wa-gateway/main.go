// rolly-wa-gateway: keeps each Rolly user's WhatsApp linked-device connection alive and exposes a small private API to
// rolly-api. See docs/WHATSAPP_GATEWAY.md. Run exactly ONE instance.
package main

import (
	"context"
	"database/sql"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	_ "github.com/mattn/go-sqlite3"
	"go.mau.fi/whatsmeow/store/sqlstore"
	waLog "go.mau.fi/whatsmeow/util/log"
)

func main() {
	cfg, err := LoadConfig()
	if err != nil {
		log.Fatal(err)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	wlog := waLog.Stdout("WA", envOr("WA_LOG_LEVEL", "INFO"), false)
	container, err := sqlstore.New(ctx, cfg.dialect(), cfg.DatabaseURL, waLog.Stdout("DB", "WARN", false))
	if err != nil {
		log.Fatalf("session store: %v", err)
	}
	db, err := sql.Open(cfg.dialect(), cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("database: %v", err)
	}
	accounts := NewAccountStore(db, cfg.dialect() == "pgx")
	if err := accounts.Migrate(ctx); err != nil {
		log.Fatalf("migrate: %v", err)
	}

	mgr := NewManager(cfg, container, accounts, wlog)
	go func() {
		if err := mgr.Start(ctx); err != nil && !errors.Is(err, context.Canceled) {
			log.Printf("start: %v", err)
		}
	}()

	srv := &http.Server{Addr: cfg.Addr, Handler: (&Server{cfg: cfg, m: mgr}).Handler(), ReadHeaderTimeout: 5 * time.Second}
	go func() {
		<-ctx.Done()
		sctx, c := context.WithTimeout(context.Background(), 10*time.Second)
		defer c()
		_ = srv.Shutdown(sctx)
	}()
	log.Printf("rolly-wa-gateway listening on %s", cfg.Addr)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
	mgr.Shutdown()
}
