package contestdata

import (
	"encoding/json"
	"errors"
	"os"
)

type Manifest struct {
	SchemaVersion     int        `json:"schemaVersion"`
	ContestID         string     `json:"contestId"`
	GeneratedAt       string     `json:"generatedAt"`
	GeneratorRevision string     `json:"generatorRevision"`
	Artifacts         []Artifact `json:"artifacts"`
}

type Artifact struct {
	ID                 string `json:"id"`
	Kind               string `json:"kind"`
	Label              string `json:"label"`
	ObjectKey          string `json:"objectKey"`
	Rows               int64  `json:"rows"`
	CompressedBytes    int64  `json:"compressedBytes"`
	UncompressedBytes  int64  `json:"uncompressedBytes"`
	CompressedSHA256   string `json:"compressedSha256"`
	UncompressedSHA256 string `json:"uncompressedSha256"`
	IsPublic           bool   `json:"isPublic"`
}

func ReadManifest(path string) (Manifest, error) {
	var manifest Manifest
	content, err := os.ReadFile(path)
	if err != nil {
		return manifest, err
	}
	err = json.Unmarshal(content, &manifest)
	return manifest, err
}

func WriteManifest(path string, manifest Manifest) error {
	content, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return err
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	_, writeErr := file.Write(append(content, '\n'))
	return errors.Join(writeErr, file.Close())
}
