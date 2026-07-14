package progress

import (
	"fmt"
	"io"
	"sync"
	"time"
)

const heartbeatInterval = 10 * time.Second

type Steps struct {
	out            io.Writer
	current, total int
}

func NewSteps(out io.Writer, total int) *Steps {
	return &Steps{out: out, total: total}
}

func (steps *Steps) Run(label string, work func() error) error {
	return steps.run(label, true, work)
}

func (steps *Steps) RunLive(label string, work func() error) error {
	return steps.run(label, false, work)
}

func (steps *Steps) RunBar(label string, total int64, unit string, work func(*Bar) error) error {
	return steps.RunLive(label, func() error {
		bar := New(steps.out, total, unit)
		err := work(bar)
		bar.Done(err == nil)
		return err
	})
}

func (steps *Steps) run(label string, heartbeat bool, work func() error) error {
	steps.current++
	step := steps.current
	started := time.Now()
	fmt.Fprintf(steps.out, "[%d/%d] %s\n", step, steps.total, label)

	done := make(chan struct{})
	var background sync.WaitGroup
	if heartbeat {
		background.Add(1)
		go func() {
			defer background.Done()
			ticker := time.NewTicker(heartbeatInterval)
			defer ticker.Stop()
			for {
				select {
				case <-ticker.C:
					fmt.Fprintf(steps.out, "[%d/%d] still running: %s (%s elapsed)\n", step, steps.total, label, time.Since(started).Round(time.Second))
				case <-done:
					return
				}
			}
		}()
	}

	err := work()
	close(done)
	background.Wait()
	status := "done"
	if err != nil {
		status = "failed"
	}
	fmt.Fprintf(steps.out, "[%d/%d] %s: %s (%s)\n", step, steps.total, status, label, time.Since(started).Round(time.Millisecond))
	return err
}
