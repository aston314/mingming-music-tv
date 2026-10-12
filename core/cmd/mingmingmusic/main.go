package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	product "github.com/aston314/mingming-music-tv"
	"github.com/aston314/mingming-music-tv/core/internal/server"
)

var buildVersion string

func main() {
	port := flag.Int("port", 0, "loopback port; zero selects a free port")
	instance := flag.String("instance-id", "desktop", "runtime identity")
	parent := flag.Int("parent-pid", 0, "Android host PID")
	fixture := flag.Bool("fixture", false, "serve deterministic data")
	flag.Parse()
	if *port < 0 || *port > 65535 || *instance == "" || strings.ContainsAny(*instance, " \r\n\t") {
		log.Fatal("invalid runtime configuration")
	}
	cfg := product.Load()
	listener, err := net.Listen("tcp4", "127.0.0.1:"+strconv.Itoa(*port))
	if err != nil {
		log.Fatal(err)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if *parent > 0 {
		go func() {
			ticker := time.NewTicker(time.Second)
			defer ticker.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-ticker.C:
					if os.Getppid() != *parent {
						stop()
						return
					}
				}
			}
		}()
	}
	dataDir := os.Getenv("MINGMING_DATA_DIR")
	if dataDir == "" {
		root, e := os.UserConfigDir()
		if e != nil {
			log.Fatal(e)
		}
		dataDir = filepath.Join(root, "mingming-music-tv")
	}
	version := buildVersion
	if version == "" {
		version = cfg.VersionName + "-dev"
	}
	core := server.New(cfg, version, *instance, dataDir, *fixture)
	if err := core.StartCompanion(ctx); err != nil {
		log.Print("phone input unavailable")
	}
	service := &http.Server{Handler: core, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 45 * time.Second}
	fmt.Printf("MINGMING_MUSIC_READY %d %s\n", listener.Addr().(*net.TCPAddr).Port, *instance)
	go func() { <-ctx.Done(); _ = service.Close() }()
	if err = service.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
