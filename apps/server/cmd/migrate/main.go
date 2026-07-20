package main

import (
	"context"
	"log"

	"github.com/cp-20/1blc-trap/apps/server/internal/server"
)

func main() {
	if err := server.Migrate(context.Background()); err != nil {
		log.Fatal(err)
	}
}
