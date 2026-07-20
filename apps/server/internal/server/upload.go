package server

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/cp-20/1blc-trap/apps/server/internal/api"
)

const sourceLimit = 1024 * 1024
const binaryLimit = 64 * 1024 * 1024

var executionKinds = map[api.ExecutionKind]bool{api.ExecutionKindNative: true, api.ExecutionKindJavascript: true, api.ExecutionKindTypescript: true, api.ExecutionKindBun: true, api.ExecutionKindRuby: true}
var nativeLanguages = map[api.Language]bool{api.LanguageC: true, api.LanguageCpp: true, api.LanguageGo: true, api.LanguageRust: true, api.LanguageZig: true, api.LanguageCsharp: true, api.LanguageOther: true}
var allLanguages = map[api.Language]bool{api.LanguageC: true, api.LanguageCpp: true, api.LanguageGo: true, api.LanguageRust: true, api.LanguageZig: true, api.LanguageCsharp: true, api.LanguageOther: true, api.LanguageJavascript: true, api.LanguageTypescript: true, api.LanguageBun: true, api.LanguageRuby: true}
var sourceExtensions = map[api.Language][]string{api.LanguageC: {".c"}, api.LanguageCpp: {".cc", ".cpp", ".cxx"}, api.LanguageGo: {".go"}, api.LanguageRust: {".rs"}, api.LanguageZig: {".zig"}, api.LanguageCsharp: {".cs"}, api.LanguageOther: {}, api.LanguageJavascript: {".js"}, api.LanguageTypescript: {".ts"}, api.LanguageBun: {".js", ".ts"}, api.LanguageRuby: {".rb"}}

type uploadedFile struct{ path, filename, digest string }
type parsedUpload struct {
	kind                                    api.ExecutionKind
	language                                api.Language
	sourceFilename                          string
	source                                  []byte
	artifactPath, artifactDigest, directory string
}

func (s *Server) acceptSubmission(w http.ResponseWriter, r *http.Request, username string) (reservation, error) {
	reserved, err := s.reserveSubmission(r.Context(), username)
	if err != nil {
		return reservation{}, err
	}
	var parsed parsedUpload
	discard := func(cause error) (reservation, error) {
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		_ = s.runner.cleanup(ctx, reserved.id)
		_ = s.discardUpload(ctx, reserved.id)
		if parsed.directory != "" {
			_ = os.RemoveAll(parsed.directory)
		}
		return reservation{}, cause
	}
	parsed, err = s.parseUpload(w, r, reserved.id)
	if err != nil {
		return discard(err)
	}
	defer os.RemoveAll(parsed.directory)
	if err = s.storeSource(r.Context(), reserved.id, parsed.sourceFilename, fileSHA256(parsed.source), parsed.source); err != nil {
		return discard(err)
	}
	if err = s.runner.upload(r.Context(), reserved.id, parsed.kind, parsed.artifactDigest, parsed.artifactPath); err != nil {
		return discard(newError(infrastructure, "runner_unavailable", "計測環境に接続できませんでした。しばらく待ってから再度提出してください", err))
	}
	if err = s.queueUpload(r.Context(), reserved.id, parsed.kind, parsed.language, parsed.sourceFilename, parsed.artifactDigest); err != nil {
		return discard(err)
	}
	return reserved, nil
}

func (s *Server) parseUpload(w http.ResponseWriter, r *http.Request, id string) (parsedUpload, error) {
	var result parsedUpload
	mediaType, params, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || strings.ToLower(mediaType) != "multipart/form-data" {
		return result, newError(badRequest, "multipart_required", "multipart/form-dataで提出してください")
	}
	boundary := params["boundary"]
	if boundary == "" {
		return result, newError(badRequest, "invalid_upload", "multipartが不正です")
	}
	if r.Body == nil || r.ContentLength == 0 {
		return result, newError(badRequest, "empty_upload", "提出内容が空です")
	}
	directory, err := os.MkdirTemp("", "1brc-upload-"+id+"-")
	if err != nil {
		return result, newError(infrastructure, "upload_storage_failed", "アップロードを保存できませんでした", err)
	}
	result.directory = directory
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Minute)
	defer cancel()
	r.Body = http.MaxBytesReader(w, r.Body, sourceLimit+binaryLimit+64*1024)
	readDone := make(chan struct{})
	defer close(readDone)
	go func() {
		select {
		case <-ctx.Done():
			_ = r.Body.Close()
		case <-readDone:
		}
	}()
	reader := multipart.NewReader(r.Body, boundary)
	fields := map[string][]string{}
	files := map[string]uploadedFile{}
	parts, fileCount := 0, 0
	for {
		if ctx.Err() != nil {
			break
		}
		part, readErr := reader.NextPart()
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			err = readErr
			break
		}
		parts++
		if parts > 4 {
			part.Close()
			err = newError(badRequest, "multipart_limit", "multipartの上限を超えています")
			break
		}
		if multipartHeaderSize(part.Header) > 4*1024 {
			part.Close()
			err = newError(badRequest, "multipart_limit", "multipartの上限を超えています")
			break
		}
		name := part.FormName()
		if name != "executionKind" && name != "language" && name != "source" && name != "binary" {
			part.Close()
			err = newError(badRequest, "invalid_metadata", "提出metadataが不正です")
			break
		}
		if part.FileName() == "" {
			content, readErr := io.ReadAll(io.LimitReader(part, 65))
			part.Close()
			if readErr != nil {
				err = readErr
				break
			}
			if len(content) > 64 {
				err = newError(badRequest, "invalid_metadata", "提出metadataが不正です")
				break
			}
			fields[name] = append(fields[name], string(content))
			continue
		}
		if name != "source" && name != "binary" {
			part.Close()
			err = newError(badRequest, "unexpected_file", "ソースコードまたは実行ファイル以外は指定できません")
			break
		}
		if _, exists := files[name]; exists {
			part.Close()
			err = newError(badRequest, "duplicate_file", name+"は1個だけ指定できます")
			break
		}
		fileCount++
		if fileCount > 2 {
			part.Close()
			err = newError(badRequest, "multipart_limit", "multipartの上限を超えています")
			break
		}
		filename, fileErr := sanitizeFilename(part.FileName())
		if fileErr != nil {
			part.Close()
			err = fileErr
			break
		}
		limit := int64(binaryLimit)
		mode := os.FileMode(0700)
		if name == "source" {
			limit = sourceLimit
			mode = 0600
		}
		path := filepath.Join(directory, name)
		target, createErr := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
		if createErr != nil {
			part.Close()
			err = createErr
			break
		}
		hash := sha256.New()
		written, copyErr := io.Copy(io.MultiWriter(target, hash), io.LimitReader(part, limit+1))
		closeErr := target.Close()
		part.Close()
		if copyErr != nil {
			err = copyErr
			break
		}
		if closeErr != nil {
			err = closeErr
			break
		}
		if written > limit {
			err = invalidFile(name)
			break
		}
		files[name] = uploadedFile{path: path, filename: filename, digest: fmt.Sprintf("%x", hash.Sum(nil))}
	}
	if err == nil && ctx.Err() != nil {
		err = ctx.Err()
	}
	if err != nil {
		_ = os.RemoveAll(directory)
		if errors.Is(err, context.DeadlineExceeded) {
			return result, newError(badRequest, "upload_timeout", "アップロードは15分以内に完了してください", err)
		}
		if errors.Is(err, context.Canceled) || r.Context().Err() != nil {
			return result, newError(badRequest, "upload_aborted", "アップロードが切断されました", err)
		}
		if _, ok := err.(*appError); ok {
			return result, err
		}
		return result, newError(badRequest, "invalid_upload", "multipartが不正です", err)
	}
	partCount := func(name string) int {
		count := len(fields[name])
		if _, ok := files[name]; ok {
			count++
		}
		return count
	}
	if partCount("executionKind") != 1 || partCount("language") > 1 || partCount("source") != 1 || partCount("binary") > 1 {
		return result, invalidMetadata()
	}
	kind := api.ExecutionKind(fields["executionKind"][0])
	if !executionKinds[kind] {
		return result, newError(badRequest, "invalid_execution_kind", "実行形式が不正です")
	}
	var language api.Language
	if kind == api.ExecutionKindNative {
		if len(fields["language"]) != 1 {
			return result, invalidFile("source")
		}
		language = api.Language(fields["language"][0])
		if !nativeLanguages[language] {
			return result, invalidFile("source")
		}
	} else {
		if len(fields["language"]) != 0 {
			return result, newError(badRequest, "unexpected_language", "スクリプト言語では実装言語を指定しません")
		}
		language = api.Language(kind)
	}
	source, ok := files["source"]
	if !ok {
		return result, invalidFile("source")
	}
	binary, hasBinary := files["binary"]
	if kind == api.ExecutionKindNative && !hasBinary {
		return result, invalidFile("binary")
	}
	if kind != api.ExecutionKindNative && hasBinary {
		return result, newError(badRequest, "unexpected_binary", "スクリプト言語では実行ファイルを指定しません")
	}
	content, err := os.ReadFile(source.path)
	if err != nil {
		return result, newError(infrastructure, "upload_storage_failed", "アップロードを読み込めませんでした", err)
	}
	if !utf8.Valid(content) {
		return result, newError(badRequest, "source_not_utf8", "ソースコードはUTF-8で提出してください")
	}
	if strings.IndexByte(string(content), 0) >= 0 {
		return result, newError(badRequest, "source_contains_nul", "ソースコードにNULバイトを含められません")
	}
	if extensions := sourceExtensions[language]; len(extensions) > 0 {
		extension := strings.ToLower(filepath.Ext(source.filename))
		valid := false
		for _, wanted := range extensions {
			if extension == wanted {
				valid = true
			}
		}
		if !valid {
			return result, newError(badRequest, "invalid_source_extension", fmt.Sprintf("%sのソースコード拡張子が不正です", language))
		}
	}
	artifact := source
	if kind == api.ExecutionKindNative {
		artifact = binary
		handle, err := os.Open(artifact.path)
		if err != nil {
			return result, err
		}
		header := make([]byte, 20)
		_, readErr := io.ReadFull(handle, header)
		handle.Close()
		if readErr != nil || !bytesEqual(header[:6], []byte{0x7f, 'E', 'L', 'F', 2, 1}) || header[18] != 0x3e || header[19] != 0 {
			return result, newError(badRequest, "invalid_elf", "Ubuntu 26.04 x86_64 ELFを提出してください")
		}
	}
	result.kind = kind
	result.language = language
	result.sourceFilename = source.filename
	result.source = content
	result.artifactPath = artifact.path
	result.artifactDigest = artifact.digest
	return result, nil
}

func invalidMetadata() error {
	return newError(badRequest, "invalid_metadata", "提出metadataが不正です")
}
func invalidFile(name string) error {
	if name == "source" {
		return newError(badRequest, "invalid_source", "ソースコードが不足しているか、1 MiBを超えています")
	}
	return newError(badRequest, "invalid_binary", "Nativeの実行ファイルが不足しているか、64 MiBを超えています")
}
func sanitizeFilename(filename string) (string, error) {
	base := strings.TrimSpace(filepath.Base(strings.ReplaceAll(filename, "\\", "/")))
	if base == "" || utf16Length(base) > 255 {
		return "", newError(badRequest, "invalid_filename", "ファイル名が不正です")
	}
	for _, r := range base {
		if r <= 0x1f || r == 0x7f {
			return "", newError(badRequest, "invalid_filename", "ファイル名が不正です")
		}
	}
	return base, nil
}

func multipartHeaderSize(header map[string][]string) int {
	total := 2
	for name, values := range header {
		for _, value := range values {
			total += len(name) + 2 + len(value) + 2
		}
	}
	return total
}

func utf16Length(value string) int { return len(utf16.Encode([]rune(value))) }

func truncateUTF16(value string, limit int) string {
	if utf16Length(value) <= limit {
		return value
	}
	units := utf16.Encode([]rune(value))
	return string(utf16.Decode(units[:limit]))
}

func encodeURIComponent(value string) string {
	const hex = "0123456789ABCDEF"
	var encoded strings.Builder
	for _, value := range []byte(value) {
		if value >= 'A' && value <= 'Z' || value >= 'a' && value <= 'z' || value >= '0' && value <= '9' || strings.ContainsRune("-_.!~*'()", rune(value)) {
			encoded.WriteByte(value)
			continue
		}
		encoded.WriteByte('%')
		encoded.WriteByte(hex[value>>4])
		encoded.WriteByte(hex[value&0x0f])
	}
	return encoded.String()
}
func bytesEqual(left, right []byte) bool {
	if len(left) != len(right) {
		return false
	}
	for i := range left {
		if left[i] != right[i] {
			return false
		}
	}
	return true
}
