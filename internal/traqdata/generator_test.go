package traqdata

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestPublicAndPrivateWordsetsDoNotOverlap(t *testing.T) {
	public := channelWordsets["public"]
	private := channelWordsets["private"]
	if len(public) != maxChannelDepth || len(private) != maxChannelDepth {
		t.Fatalf("wordsets must have %d levels", maxChannelDepth)
	}

	publicWords := make(map[string]struct{})
	for depth := range public {
		if len(public[depth]) != len(private[depth]) {
			t.Fatalf("word count differs at depth %d: public=%d private=%d", depth+1, len(public[depth]), len(private[depth]))
		}
		for _, word := range public[depth] {
			publicWords[word] = struct{}{}
		}
	}
	for _, words := range private {
		for _, word := range words {
			if _, exists := publicWords[word]; exists {
				t.Fatalf("word %q is shared by public and private", word)
			}
		}
	}
}

func TestGeneratorIsDeterministicAndOptimizedMatchesBaseline(t *testing.T) {
	repository, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	directory := t.TempDir()
	first := filepath.Join(directory, "first.csv")
	second := filepath.Join(directory, "second.csv")
	optimized := filepath.Join(directory, "optimized.expected")
	baseline := filepath.Join(directory, "baseline.expected")
	options := Options{Rows: 2000, Channels: 100, Seed: 424242, Wordset: PublicWordset}

	if err := GenerateFile(first, options); err != nil {
		t.Fatal(err)
	}
	if err := GenerateFile(second, options); err != nil {
		t.Fatal(err)
	}
	firstContent, err := os.ReadFile(first)
	if err != nil {
		t.Fatal(err)
	}
	secondContent, err := os.ReadFile(second)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(firstContent, secondContent) {
		t.Fatal("the same seed did not produce identical CSV data")
	}

	runRepositoryGo(t, repository, "./optimized/go", "-i", first, "-o", optimized, "-t", "2")
	runRepositoryGo(t, repository, "./baselines/go", "-i", first, "-o", baseline)
	optimizedContent, err := os.ReadFile(optimized)
	if err != nil {
		t.Fatal(err)
	}
	baselineContent, err := os.ReadFile(baseline)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(optimizedContent, baselineContent) {
		t.Fatal("optimized Go expected result differs from the independent Go baseline")
	}
}

func runRepositoryGo(t *testing.T, repository string, arguments ...string) {
	t.Helper()
	command := exec.Command("go", append([]string{"run"}, arguments...)...)
	command.Dir = repository
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("go %v: %v\n%s", arguments, err, output)
	}
}
