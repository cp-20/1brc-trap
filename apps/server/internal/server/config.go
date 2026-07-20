package server

import (
	"encoding/base64"
	"fmt"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	NodeEnv, AppOrigin, StaticRoot                                  string
	Port                                                            int
	ContestID                                                       string
	ContestStartAt, ContestEndAt                                    time.Time
	Admins                                                          map[string]bool
	TrustProxyHeader                                                bool
	DBName, DBHost, DBPassword, DBUser                              string
	DBPort                                                          int
	R2AccountID, R2BucketName, R2AccessKeyID, R2SecretAccessKey     string
	R2Endpoint, R2InternalEndpoint                                  string
	RunnerSSHHost, RunnerSSHUser, RunnerSSHPassword                 string
	RunnerSSHPrivateKeyPath, RunnerSSHPrivateKeyBase64              string
	RunnerSSHHostKeySHA256                                          string
	RunnerSSHPort                                                   int
	BenchmarkEnvironmentID, BenchmarkInstanceType                   string
	BenchmarkCPU, BenchmarkMemory, BenchmarkRunnerImage             string
	BenchmarkKernel, BenchmarkDockerVersion                         string
	BenchmarkNodeVersion, BenchmarkBunVersion, BenchmarkRubyVersion string
	BenchmarkSharedLibraries                                        []string
	LogLevel, ProfilingSecret                                       string
	ProfilingPort                                                   int
}

func LoadConfig() (Config, error) {
	var c Config
	c.NodeEnv = envDefault("NODE_ENV", "development")
	c.AppOrigin = envDefault("APP_ORIGIN", "http://localhost:8080")
	c.StaticRoot = envDefault("STATIC_ROOT", "../web/dist")
	c.ContestID = envDefault("CONTEST_ID", "1brc-trap-2026")
	c.R2Endpoint = os.Getenv("R2_ENDPOINT")
	c.R2InternalEndpoint = os.Getenv("R2_INTERNAL_ENDPOINT")
	c.RunnerSSHPrivateKeyPath = os.Getenv("RUNNER_SSH_PRIVATE_KEY_PATH")
	c.RunnerSSHPrivateKeyBase64 = os.Getenv("RUNNER_SSH_PRIVATE_KEY_BASE64")
	c.RunnerSSHPassword = os.Getenv("RUNNER_SSH_PASSWORD")
	c.RunnerSSHHostKeySHA256 = os.Getenv("RUNNER_SSH_HOST_KEY_SHA256")
	c.BenchmarkInstanceType = envDefault("BENCHMARK_INSTANCE_TYPE", "r7i.2xlarge")
	c.BenchmarkCPU = envDefault("BENCHMARK_CPU", "8 vCPU")
	c.BenchmarkMemory = envDefault("BENCHMARK_MEMORY", "64 GiB")
	c.BenchmarkKernel = envDefault("BENCHMARK_KERNEL", "Ubuntu 26.04 standard kernel")
	c.BenchmarkDockerVersion = envDefault("BENCHMARK_DOCKER_VERSION", "29.x")
	c.BenchmarkNodeVersion = envDefault("BENCHMARK_NODE_VERSION", "24.18.0")
	c.BenchmarkBunVersion = envDefault("BENCHMARK_BUN_VERSION", "1.3.14")
	c.BenchmarkRubyVersion = envDefault("BENCHMARK_RUBY_VERSION", "4.0.5")
	c.LogLevel = envDefault("LOG_LEVEL", "info")
	c.ProfilingSecret = os.Getenv("PROFILING_SECRET")
	if c.NodeEnv != "development" && c.NodeEnv != "test" && c.NodeEnv != "production" {
		return c, fmt.Errorf("NODE_ENV must be development, test, or production")
	}
	if c.LogLevel != "debug" && c.LogLevel != "info" && c.LogLevel != "warn" && c.LogLevel != "error" {
		return c, fmt.Errorf("LOG_LEVEL must be debug, info, warn, or error")
	}

	var err error
	if c.Port, err = envInt("PORT", 3000); err != nil {
		return c, err
	}
	if c.DBPort, err = envInt("NS_MARIADB_PORT", 0); err != nil {
		return c, err
	}
	if c.RunnerSSHPort, err = envInt("RUNNER_SSH_PORT", 22); err != nil {
		return c, err
	}
	if c.ProfilingPort, err = envInt("PROFILING_PORT", 6499); err != nil {
		return c, err
	}
	if c.ContestStartAt, err = envTime("CONTEST_START_AT"); err != nil {
		return c, err
	}
	if c.ContestEndAt, err = envTime("CONTEST_END_AT"); err != nil {
		return c, err
	}
	if !c.ContestStartAt.Before(c.ContestEndAt) {
		return c, fmt.Errorf("CONTEST_START_AT must be earlier than CONTEST_END_AT")
	}

	requiredStrings := map[string]*string{
		"NS_MARIADB_DATABASE":      &c.DBName,
		"NS_MARIADB_HOSTNAME":      &c.DBHost,
		"NS_MARIADB_USER":          &c.DBUser,
		"R2_ACCOUNT_ID":            &c.R2AccountID,
		"R2_BUCKET_NAME":           &c.R2BucketName,
		"R2_ACCESS_KEY_ID":         &c.R2AccessKeyID,
		"R2_SECRET_ACCESS_KEY":     &c.R2SecretAccessKey,
		"RUNNER_SSH_HOST":          &c.RunnerSSHHost,
		"BENCHMARK_ENVIRONMENT_ID": &c.BenchmarkEnvironmentID,
		"BENCHMARK_RUNNER_IMAGE":   &c.BenchmarkRunnerImage,
	}
	for name, target := range requiredStrings {
		*target = os.Getenv(name)
		if *target == "" {
			return c, required(name)
		}
	}
	var passwordPresent bool
	c.DBPassword, passwordPresent = os.LookupEnv("NS_MARIADB_PASSWORD")
	if !passwordPresent {
		return c, required("NS_MARIADB_PASSWORD")
	}
	c.RunnerSSHUser = envDefault("RUNNER_SSH_USER", "onebrc")
	if c.DBPort < 1 || c.Port < 1 || c.RunnerSSHPort < 1 {
		return c, fmt.Errorf("ports must be positive integers")
	}
	if c.ContestID == "" {
		return c, required("CONTEST_ID")
	}
	if c.RunnerSSHUser == "" {
		return c, required("RUNNER_SSH_USER")
	}
	if !absoluteURL(c.AppOrigin) {
		return c, fmt.Errorf("APP_ORIGIN must be a URL")
	}
	for name, value := range map[string]string{"R2_ENDPOINT": c.R2Endpoint, "R2_INTERNAL_ENDPOINT": c.R2InternalEndpoint} {
		if value != "" {
			if !absoluteURL(value) {
				return c, fmt.Errorf("%s must be a URL", name)
			}
		}
	}
	trustProxyHeader := envDefault("TRUST_PROXY_HEADER", "true")
	if trustProxyHeader != "true" && trustProxyHeader != "false" {
		return c, fmt.Errorf("TRUST_PROXY_HEADER must be true or false")
	}
	c.TrustProxyHeader = trustProxyHeader == "true"
	c.Admins = splitSet(os.Getenv("ADMIN_USERS"))
	c.BenchmarkSharedLibraries = splitList(envDefault("BENCHMARK_SHARED_LIBRARIES", "libc6,libgcc-s1,libstdc++6,zlib1g,libssl3t64,libyaml-0-2,libreadline8t64,libffi8,libgdbm6t64"))
	if c.RunnerSSHPrivateKeyPath == "" && c.RunnerSSHPrivateKeyBase64 == "" && c.RunnerSSHPassword == "" {
		return c, fmt.Errorf("RUNNER_SSH_PRIVATE_KEY_PATH, RUNNER_SSH_PRIVATE_KEY_BASE64, or RUNNER_SSH_PASSWORD is required")
	}
	if c.RunnerSSHPrivateKeyBase64 != "" {
		if _, err := base64.StdEncoding.DecodeString(c.RunnerSSHPrivateKeyBase64); err != nil {
			return c, fmt.Errorf("RUNNER_SSH_PRIVATE_KEY_BASE64 is invalid: %w", err)
		}
	}
	if c.RunnerSSHHostKeySHA256 != "" && !hostKeyPattern.MatchString(c.RunnerSSHHostKeySHA256) {
		return c, fmt.Errorf("RUNNER_SSH_HOST_KEY_SHA256 is invalid")
	}
	if c.NodeEnv == "production" && (c.RunnerSSHPrivateKeyPath != "" || c.RunnerSSHPrivateKeyBase64 != "") && c.RunnerSSHHostKeySHA256 == "" {
		return c, fmt.Errorf("RUNNER_SSH_HOST_KEY_SHA256 is required with a production SSH private key")
	}
	if c.ProfilingSecret != "" {
		if len(c.ProfilingSecret) < 32 || strings.Trim(c.ProfilingSecret, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-") != "" {
			return c, fmt.Errorf("PROFILING_SECRET must be at least 32 characters and contain only A-Z, a-z, 0-9, _ and -")
		}
		if c.ProfilingPort < 1 || c.ProfilingPort > 65535 {
			return c, fmt.Errorf("PROFILING_PORT must be an integer between 1 and 65535")
		}
	}
	return c, nil
}

func envDefault(name, fallback string) string {
	if value, exists := os.LookupEnv(name); exists {
		return value
	}
	return fallback
}
func envInt(name string, fallback int) (int, error) {
	value, exists := os.LookupEnv(name)
	if !exists {
		return fallback, nil
	}
	n, err := strconv.Atoi(value)
	if err != nil {
		return 0, fmt.Errorf("%s must be an integer", name)
	}
	return n, nil
}

var hostKeyPattern = regexp.MustCompile(`^(?:SHA256:)?[A-Za-z0-9+/]+={0,2}$`)

func absoluteURL(value string) bool {
	parsed, err := url.Parse(value)
	return err == nil && parsed.Scheme != "" && parsed.Host != ""
}
func envTime(name string) (time.Time, error) {
	value := os.Getenv(name)
	if value == "" {
		return time.Time{}, required(name)
	}
	t, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return time.Time{}, fmt.Errorf("%s must be an ISO date: %w", name, err)
	}
	return t.UTC(), nil
}
func splitList(value string) []string {
	var out []string
	for _, item := range strings.Split(value, ",") {
		if item = strings.TrimSpace(item); item != "" {
			out = append(out, item)
		}
	}
	return out
}
func splitSet(value string) map[string]bool {
	out := map[string]bool{}
	for _, item := range splitList(value) {
		out[item] = true
	}
	return out
}
