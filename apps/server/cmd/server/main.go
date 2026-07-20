package main

import (
	"context"
	"log"
	"os/signal"
	"syscall"

	"github.com/cp-20/1blc-trap/apps/server/internal/server"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if err := server.Run(ctx); err != nil {
		log.Fatal(err)
	}
}
