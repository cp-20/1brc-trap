package server

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/cp-20/1blc-trap/apps/server/internal/api"
	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
	"github.com/labstack/echo/v5/middleware"
)

type Server struct {
	config Config
	db     *sql.DB
	runner *runnerClient
	r2     *r2Client
	logger *slog.Logger
}

func New(config Config, db *sql.DB, runner *runnerClient, r2 *r2Client, logger *slog.Logger) *Server {
	return &Server{config: config, db: db, runner: runner, r2: r2, logger: logger}
}

type contextKey int

const (
	requestIDKey contextKey = iota
	authUserKey
)

var usernamePattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

func requestID(r *http.Request) string {
	value, _ := r.Context().Value(requestIDKey).(string)
	return value
}
func authenticated(r *http.Request) *authUser {
	value, _ := r.Context().Value(authUserKey).(*authUser)
	return value
}

func (s *Server) Handler() *echo.Echo {
	e := echo.New()
	e.Logger = s.logger
	e.HTTPErrorHandler = func(c *echo.Context, err error) {
		if response, ok := c.Response().(*echo.Response); ok && response.Committed {
			return
		}
		var httpError *echo.HTTPError
		if errors.As(err, &httpError) && (httpError.Code == http.StatusNotFound || httpError.Code == http.StatusMethodNotAllowed) {
			if strings.HasPrefix(c.Request().URL.Path, "/api/") {
				s.writeError(c.Response(), c.Request(), newError(notFound, "not_found", "Not found"))
				return
			}
			_ = c.String(http.StatusNotFound, "Not Found")
			return
		}
		if strings.HasPrefix(c.Request().URL.Path, "/api/") && errors.As(err, &httpError) && httpError.Code == http.StatusBadRequest {
			s.writeError(c.Response(), c.Request(), newError(badRequest, "invalid_request", "リクエストの形式が不正です"))
			return
		}
		s.logger.Error("request failed", "requestId", requestID(c.Request()), "error", err)
		s.writeError(c.Response(), c.Request(), asAppError(err))
	}
	e.Use(middleware.Recover(), middleware.Secure(), s.commonMiddleware, s.apiAuthenticationMiddleware)
	api.RegisterHandlers(e, generatedServer{server: s})
	e.RouteNotFound("/*", s.staticFallback)
	return e
}

func (s *Server) apiAuthenticationMiddleware(next echo.HandlerFunc) echo.HandlerFunc {
	authenticatedNext := s.authenticationMiddleware(next)
	return func(c *echo.Context) error {
		if strings.HasPrefix(c.Request().URL.Path, "/api/") {
			return authenticatedNext(c)
		}
		return next(c)
	}
}
func (s *Server) staticFallback(c *echo.Context) error {
	r := c.Request()
	if strings.HasPrefix(r.URL.Path, "/api/") {
		s.writeError(c.Response(), r, newError(notFound, "not_found", "Not found"))
		return nil
	}
	if r.Method != "GET" && r.Method != "HEAD" {
		return echo.ErrNotFound
	}
	clean := filepath.Clean(strings.TrimPrefix(r.URL.Path, "/"))
	if clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		clean = "index.html"
	}
	if clean == "." {
		clean = "index.html"
	}
	path := filepath.Join(s.config.StaticRoot, clean)
	if info, err := os.Stat(path); err == nil && !info.IsDir() {
		return c.File(path)
	}
	index := filepath.Join(s.config.StaticRoot, "index.html")
	if _, err := os.Stat(index); err != nil {
		return c.String(http.StatusNotFound, "Frontend is not built")
	}
	return c.File(index)
}
func (s *Server) commonMiddleware(next echo.HandlerFunc) echo.HandlerFunc {
	return func(c *echo.Context) error {
		r := c.Request()
		id := r.Header.Get("X-Request-Id")
		if id == "" {
			id = uuid.NewString()
		}
		r = r.WithContext(context.WithValue(r.Context(), requestIDKey, id))
		c.SetRequest(r)
		c.Response().Header().Set("X-Request-Id", id)
		c.Response().Header().Set("Referrer-Policy", "no-referrer")
		c.Response().Header().Set("Cross-Origin-Resource-Policy", "same-origin")
		c.Response().Header().Set("X-DNS-Prefetch-Control", "off")
		c.Response().Header().Set("X-Download-Options", "noopen")
		c.Response().Header().Set("X-Permitted-Cross-Domain-Policies", "none")
		if r.URL.Path == "/og.png" {
			c.Response().Header().Set("Access-Control-Allow-Origin", "*")
			c.Response().Header().Set("Cross-Origin-Resource-Policy", "cross-origin")
		}
		return next(c)
	}
}

func (s *Server) authenticationMiddleware(next echo.HandlerFunc) echo.HandlerFunc {
	return func(c *echo.Context) error {
		r := c.Request()
		w := c.Response()
		var user *authUser
		authorization := r.Header.Get("Authorization")
		if strings.HasPrefix(authorization, "Bearer 1brc_") && tokenMayAuthenticate(r.Method, r.URL.Path) {
			token := strings.TrimPrefix(authorization, "Bearer ")
			digest := sha256.Sum256([]byte(token))
			found, err := s.userForToken(r.Context(), digest)
			if err != nil {
				s.writeError(w, r, err)
				return nil
			}
			if found != nil {
				if subtle.ConstantTimeCompare(found.tokenHash, digest[:]) == 1 {
					user = found
					go s.touchToken(user.username)
				}
			}
		} else if s.config.TrustProxyHeader {
			forwarded := r.Header.Get("X-Forwarded-User")
			if usernamePattern.MatchString(forwarded) {
				user = &authUser{username: forwarded, isAdmin: s.config.Admins[forwarded], method: api.Header}
			}
		}
		if user != nil {
			if err := s.ensureUser(r.Context(), user.username); err != nil {
				s.writeError(w, r, err)
				return nil
			}
		}
		if user != nil && user.method == api.Header && r.Method != "GET" && r.Method != "HEAD" && r.Method != "OPTIONS" && r.Header.Get("Origin") != s.config.AppOrigin {
			s.writeError(w, r, newError(forbidden, "invalid_origin", "Originが一致しません"))
			return nil
		}
		r = r.WithContext(context.WithValue(r.Context(), authUserKey, user))
		c.SetRequest(r)
		return next(c)
	}
}
func tokenMayAuthenticate(method, path string) bool {
	if path == "/api/v1/submissions" {
		return method == "GET" || method == "POST"
	}
	if method != "GET" || !strings.HasPrefix(path, "/api/v1/submissions/") {
		return false
	}
	tail := strings.TrimPrefix(path, "/api/v1/submissions/")
	return !strings.Contains(tail, "/") && uuidPattern.MatchString(tail)
}

var uuidPattern = regexp.MustCompile(`(?i)^[0-9a-f-]{36}$`)

func (s *Server) requireUser(r *http.Request) (*authUser, error) {
	user := authenticated(r)
	if user == nil {
		return nil, newError(unauthorized, "authentication_required", "ログインまたはアクセスキーが必要です")
	}
	return user, nil
}
func (s *Server) requireHeaderUser(r *http.Request) (*authUser, error) {
	user, err := s.requireUser(r)
	if err != nil {
		return nil, err
	}
	if user.method != api.Header {
		return nil, newError(forbidden, "browser_auth_required", "ブラウザからログインしてください")
	}
	return user, nil
}
func (s *Server) requireAdmin(r *http.Request) (*authUser, error) {
	user, err := s.requireHeaderUser(r)
	if err != nil {
		return nil, err
	}
	if !user.isAdmin {
		return nil, newError(forbidden, "admin_required", "管理者権限が必要です")
	}
	return user, nil
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=UTF-8")
	w.WriteHeader(status)
	encoder := json.NewEncoder(w)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(value)
}
func (s *Server) writeError(w http.ResponseWriter, r *http.Request, err error) {
	app := asAppError(err)
	writeJSON(w, app.status(), map[string]any{"error": map[string]any{"code": app.code, "message": app.message, "requestId": requestID(r)}})
}
