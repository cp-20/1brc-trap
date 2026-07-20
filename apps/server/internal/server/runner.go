package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"strings"
	"time"

	"github.com/cp-20/1blc-trap/apps/server/internal/api"
	"golang.org/x/crypto/ssh"
)

type benchmarkResult struct {
	Verdict     api.Verdict `json:"verdict"`
	DurationsNS []string    `json:"durationsNs"`
	MedianNS    *string     `json:"medianNs"`
	Error       *string     `json:"error"`
}
type runnerJobResult struct {
	Public        benchmarkResult  `json:"public"`
	Private       *benchmarkResult `json:"private"`
	EnvironmentID string           `json:"environmentId"`
}

type runnerClient struct {
	address       string
	config        *ssh.ClientConfig
	environmentID string
}

func newRunnerClient(config Config) (*runnerClient, error) {
	auth := []ssh.AuthMethod{}
	if config.RunnerSSHPrivateKeyBase64 != "" || config.RunnerSSHPrivateKeyPath != "" {
		var key []byte
		var err error
		if config.RunnerSSHPrivateKeyBase64 != "" {
			key, err = base64.StdEncoding.DecodeString(config.RunnerSSHPrivateKeyBase64)
		} else {
			key, err = os.ReadFile(config.RunnerSSHPrivateKeyPath)
		}
		if err != nil {
			return nil, err
		}
		signer, err := ssh.ParsePrivateKey(key)
		if err != nil {
			return nil, err
		}
		auth = append(auth, ssh.PublicKeys(signer))
	} else {
		auth = append(auth, ssh.Password(config.RunnerSSHPassword))
	}
	hostKey := ssh.InsecureIgnoreHostKey()
	if expected := strings.TrimSuffix(strings.TrimPrefix(config.RunnerSSHHostKeySHA256, "SHA256:"), "="); expected != "" {
		hostKey = func(_ string, _ net.Addr, key ssh.PublicKey) error {
			actual := strings.TrimSuffix(strings.TrimPrefix(ssh.FingerprintSHA256(key), "SHA256:"), "=")
			if actual != expected {
				return fmt.Errorf("runner host key mismatch")
			}
			return nil
		}
	}
	return &runnerClient{address: net.JoinHostPort(config.RunnerSSHHost, fmt.Sprint(config.RunnerSSHPort)), environmentID: config.BenchmarkEnvironmentID, config: &ssh.ClientConfig{User: config.RunnerSSHUser, Auth: auth, HostKeyCallback: hostKey, Timeout: 15 * time.Second}}, nil
}

func (c *runnerClient) connect(ctx context.Context) (*ssh.Client, error) {
	deadline := time.Now().Add(15 * time.Second)
	delay := 250 * time.Millisecond
	var last error
	for attempt := 0; attempt < 7; attempt++ {
		client, err := ssh.Dial("tcp", c.address, c.config)
		if err == nil {
			return client, nil
		}
		last = err
		if !transientConnectionError(err) || time.Now().Add(delay).After(deadline) {
			break
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(delay):
		}
		delay *= 2
		if delay > 2500*time.Millisecond {
			delay = 2500 * time.Millisecond
		}
	}
	return nil, last
}
func transientConnectionError(err error) bool {
	var netErr net.Error
	if errors.As(err, &netErr) {
		return true
	}
	text := err.Error()
	for _, code := range []string{"connection refused", "connection reset", "no route to host", "timed out"} {
		if strings.Contains(strings.ToLower(text), code) {
			return true
		}
	}
	return false
}

type tailBuffer struct {
	data  []byte
	limit int
}

func (b *tailBuffer) Write(p []byte) (int, error) {
	b.data = append(b.data, p...)
	if len(b.data) > b.limit {
		b.data = b.data[len(b.data)-b.limit:]
	}
	return len(p), nil
}

func (c *runnerClient) command(ctx context.Context, command string, stdin io.Reader, timeout time.Duration) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	client, err := c.connect(ctx)
	if err != nil {
		return "", err
	}
	defer client.Close()
	session, err := client.NewSession()
	if err != nil {
		return "", err
	}
	defer session.Close()
	var stdout bytes.Buffer
	stderr := &tailBuffer{limit: 4096}
	session.Stdout = &stdout
	session.Stderr = stderr
	session.Stdin = stdin
	done := make(chan error, 1)
	go func() { done <- session.Run(command) }()
	select {
	case err := <-done:
		if err != nil {
			return "", fmt.Errorf("runner exited: %s: %w", string(stderr.data), err)
		}
		return stdout.String(), nil
	case <-ctx.Done():
		_ = client.Close()
		return "", fmt.Errorf("runner command timed out: %w", ctx.Err())
	}
}
func (c *runnerClient) upload(ctx context.Context, id string, kind api.ExecutionKind, digest, path string) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	_, err = c.command(ctx, fmt.Sprintf("upload %s %s %s", id, kind, digest), file, 15*time.Minute)
	return err
}
func (c *runnerClient) run(ctx context.Context, id string, kind api.ExecutionKind) (runnerJobResult, error) {
	output, err := c.command(ctx, fmt.Sprintf("run %s %s", id, kind), nil, (3*2*900+5*60)*time.Second)
	if err != nil {
		return runnerJobResult{}, err
	}
	result, err := decodeRunnerResult([]byte(output))
	if err != nil {
		return result, err
	}
	if result.EnvironmentID != c.environmentID {
		return result, fmt.Errorf("runner environment mismatch: %s", result.EnvironmentID)
	}
	if err := validateBenchmarkResult(result.Public); err != nil {
		return result, err
	}
	if result.Private != nil {
		if err := validateBenchmarkResult(*result.Private); err != nil {
			return result, err
		}
	}
	return result, nil
}

func decodeRunnerResult(content []byte) (runnerJobResult, error) {
	var raw struct {
		Public        json.RawMessage `json:"public"`
		Private       json.RawMessage `json:"private"`
		EnvironmentID string          `json:"environmentId"`
	}
	if err := decodeStrictJSON(content, &raw); err != nil {
		return runnerJobResult{}, err
	}
	if raw.Public == nil || raw.Private == nil || raw.EnvironmentID == "" {
		return runnerJobResult{}, fmt.Errorf("invalid runner result")
	}
	var result runnerJobResult
	result.EnvironmentID = raw.EnvironmentID
	if err := decodeBenchmarkResult(raw.Public, &result.Public); err != nil {
		return result, err
	}
	if string(bytes.TrimSpace(raw.Private)) != "null" {
		var private benchmarkResult
		if err := decodeBenchmarkResult(raw.Private, &private); err != nil {
			return result, err
		}
		result.Private = &private
	}
	return result, nil
}

func decodeBenchmarkResult(content []byte, result *benchmarkResult) error {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(content, &fields); err != nil || len(fields) != 4 || fields["verdict"] == nil || fields["durationsNs"] == nil || fields["medianNs"] == nil || fields["error"] == nil {
		return fmt.Errorf("invalid benchmark result")
	}
	if err := decodeStrictJSON(content, result); err != nil {
		return err
	}
	if err := validateBenchmarkResult(*result); err != nil {
		return err
	}
	if result.Verdict == api.Accepted {
		if string(bytes.TrimSpace(fields["error"])) != "null" {
			return fmt.Errorf("invalid accepted runner result")
		}
	} else if string(bytes.TrimSpace(fields["durationsNs"])) != "null" || string(bytes.TrimSpace(fields["medianNs"])) != "null" {
		return fmt.Errorf("invalid failed runner result")
	}
	return nil
}

func decodeStrictJSON(content []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(content))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return fmt.Errorf("invalid trailing JSON")
	}
	return nil
}
func (c *runnerClient) cancel(ctx context.Context, id string) error {
	_, err := c.command(ctx, "cancel "+id, nil, time.Minute)
	return err
}
func (c *runnerClient) cleanup(ctx context.Context, id string) error {
	_, err := c.command(ctx, "cleanup "+id, nil, 30*time.Second)
	return err
}
func validateBenchmarkResult(result benchmarkResult) error {
	if !validVerdict(result.Verdict) {
		return fmt.Errorf("invalid runner verdict")
	}
	if result.Verdict == api.Accepted {
		if result.MedianNS == nil || !digits(*result.MedianNS) || (len(result.DurationsNS) != 1 && len(result.DurationsNS) != 3) {
			return fmt.Errorf("invalid accepted runner result")
		}
		for _, value := range result.DurationsNS {
			if !digits(value) {
				return fmt.Errorf("invalid runner duration")
			}
		}
	} else if result.MedianNS != nil || result.DurationsNS != nil {
		return fmt.Errorf("invalid failed runner result")
	}
	return nil
}
func validVerdict(value api.Verdict) bool {
	switch value {
	case api.Accepted, api.WrongAnswer, api.RuntimeError, api.TimeLimit, api.OutputLimit, api.InvalidSubmission, api.InfrastructureError, api.Disqualified:
		return true
	}
	return false
}
func digits(value string) bool {
	if value == "" {
		return false
	}
	for _, r := range value {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}
func fileSHA256(content []byte) string {
	sum := sha256.Sum256(content)
	return fmt.Sprintf("%x", sum[:])
}
