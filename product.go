package product

import (
	_ "embed"
	"encoding/json"
)

//go:embed app.json
var configJSON []byte

type Config struct {
	ProductID     string   `json:"productId"`
	DisplayName   string   `json:"displayName"`
	ApplicationID string   `json:"applicationId"`
	VersionName   string   `json:"versionName"`
	VersionCode   int      `json:"versionCode"`
	MinSDK        int      `json:"minSdk"`
	ABIs          []string `json:"abis"`
	Upstream      string   `json:"upstream"`
	PlayerAdapter string   `json:"playerAdapter"`
	Stage         string   `json:"stage"`
}

func Load() Config {
	var cfg Config
	if err := json.Unmarshal(configJSON, &cfg); err != nil {
		panic(err)
	}
	if cfg.DisplayName == "" || cfg.ApplicationID == "" || cfg.MinSDK < 23 || cfg.Upstream == "" {
		panic("invalid product configuration")
	}
	return cfg
}
