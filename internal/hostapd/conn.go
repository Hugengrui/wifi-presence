package hostapd

import (
	"net"
	"os"
	"time"
)

// newUnixSocketConn creates a connection with a Unix domain socket at
// remotePath. The localPath is used for the local Unix socket file and
// is typically in a temporary directory.
func newUnixSocketConn(localPath, remotePath string) (*conn, error) {
	// Clean up any stale local socket file left behind by a previous crash
	// or forced restart before binding this client-side unixgram socket.
	if err := removeSocketFile(localPath); err != nil {
		return nil, err
	}

	laddr, err := net.ResolveUnixAddr("unixgram", localPath)
	if err != nil {
		return nil, err
	}

	raddr, err := net.ResolveUnixAddr("unixgram", remotePath)
	if err != nil {
		return nil, err
	}

	c, err := net.DialUnix("unixgram", laddr, raddr)
	if err != nil {
		return nil, err
	}

	return &conn{
		localSock: laddr.String(),
		UnixConn:  *c,
	}, nil
}

func removeSocketFile(p string) error {
	err := os.Remove(p)
	if err == nil || os.IsNotExist(err) {
		return nil
	}
	return err
}

// conn is a connection to hostapd's control interface.
type conn struct {
	localSock string
	net.UnixConn
}

func (c *conn) setReadDeadline(timeout time.Duration) error {
	return c.SetReadDeadline(time.Now().Add(timeout))
}

func (c *conn) unsetReadDeadline() error {
	return c.SetReadDeadline(time.Time{})
}

func (c *conn) setWriteDeadline(timeout time.Duration) error {
	return c.SetWriteDeadline(time.Now().Add(timeout))
}

// Close closes the connection and deletes the local
// socket file.
func (c *conn) Close() error {
	cErr := c.UnixConn.Close()
	// Remove local socket file.
	fErr := removeSocketFile(c.localSock)

	if cErr != nil {
		return cErr
	}
	return fErr
}
