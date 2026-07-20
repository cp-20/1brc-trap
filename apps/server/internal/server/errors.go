package server

import (
	"errors"
	"fmt"
	"net/http"
)

type errorKind string

const (
	badRequest     errorKind = "bad_request"
	unauthorized   errorKind = "unauthorized"
	forbidden      errorKind = "forbidden"
	notFound       errorKind = "not_found"
	conflict       errorKind = "conflict"
	infrastructure errorKind = "infrastructure"
)

type appError struct {
	kind    errorKind
	code    string
	message string
	cause   error
}

func (e *appError) Error() string { return e.message }
func (e *appError) Unwrap() error { return e.cause }

func newError(kind errorKind, code, message string, cause ...error) *appError {
	var wrapped error
	if len(cause) > 0 {
		wrapped = cause[0]
	}
	return &appError{kind: kind, code: code, message: message, cause: wrapped}
}

func asAppError(err error) *appError {
	var target *appError
	if errors.As(err, &target) {
		return target
	}
	return newError(infrastructure, "internal_error", "Internal server error", err)
}

func (e *appError) status() int {
	switch e.kind {
	case badRequest:
		return http.StatusBadRequest
	case unauthorized:
		return http.StatusUnauthorized
	case forbidden:
		return http.StatusForbidden
	case notFound:
		return http.StatusNotFound
	case conflict:
		return http.StatusConflict
	default:
		return http.StatusInternalServerError
	}
}

func databaseError(err error) *appError {
	return newError(infrastructure, "database_error", "Database operation failed", err)
}

func transactionError(err error) *appError {
	if _, ok := err.(*appError); ok {
		return err.(*appError)
	}
	return newError(infrastructure, "database_error", "Database transaction failed", err)
}

func required(name string) error {
	return fmt.Errorf("%s is required", name)
}
