// Launcher for the packaged game: serves the built game (folder "juego" next to the
// executable) on localhost and opens the default browser. Browsers refuse to load the
// maps and GLB models from file://, so double-clicking index.html would not work.
package main

import (
	"errors"
	"fmt"
	"mime"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const preferredPort = 8642

// Explicit types: Windows can map .js to text/plain in the registry, which breaks ES modules.
var contentTypes = map[string]string{
	".html": "text/html; charset=utf-8",
	".js":   "text/javascript; charset=utf-8",
	".mjs":  "text/javascript; charset=utf-8",
	".css":  "text/css; charset=utf-8",
	".json": "application/json",
	".svg":  "image/svg+xml",
	".png":  "image/png",
	".jpg":  "image/jpeg",
	".webp": "image/webp",
	".glb":  "model/gltf-binary",
	".gltf": "model/gltf+json",
	".bin":  "application/octet-stream",
	".wav":  "audio/wav",
	".mp3":  "audio/mpeg",
	".ogg":  "audio/ogg",
	".mp4":  "video/mp4",
	".webm": "video/webm",
	".wasm": "application/wasm",
	".pdf":  "application/pdf",
}

func main() {
	root, err := findGameDir()
	if err != nil {
		fail(err)
	}
	for ext, kind := range contentTypes {
		_ = mime.AddExtensionType(ext, kind)
	}

	listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", preferredPort))
	if err != nil {
		// Port busy (maybe the game is already open): take any free port.
		listener, err = net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			fail(err)
		}
	}
	url := fmt.Sprintf("http://%s/", listener.Addr().String())

	files := http.FileServer(http.Dir(root))
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if kind, ok := contentTypes[strings.ToLower(filepath.Ext(r.URL.Path))]; ok {
			w.Header().Set("Content-Type", kind)
		}
		files.ServeHTTP(w, r)
	})

	fmt.Println("Z3R0-FRECUENCY")
	fmt.Println("==============")
	fmt.Println("El juego se esta abriendo en tu navegador:")
	fmt.Println("  " + url)
	fmt.Println()
	fmt.Println("Si no se abre solo, copia esa direccion en Chrome, Edge, Firefox o Safari.")
	fmt.Println("Deja esta ventana abierta mientras juegas. Cierrala para salir.")

	go func() {
		time.Sleep(400 * time.Millisecond)
		openBrowser(url)
	}()
	if err := http.Serve(listener, handler); err != nil {
		fail(err)
	}
}

// findGameDir looks for "juego/index.html" next to the executable, then in the working directory.
func findGameDir() (string, error) {
	var candidates []string
	if exe, err := os.Executable(); err == nil {
		if resolved, err := filepath.EvalSymlinks(exe); err == nil {
			exe = resolved
		}
		dir := filepath.Dir(exe)
		candidates = append(candidates, filepath.Join(dir, "juego"), filepath.Join(dir, "..", "juego"))
	}
	if wd, err := os.Getwd(); err == nil {
		candidates = append(candidates, filepath.Join(wd, "juego"))
	}
	for _, dir := range candidates {
		if _, err := os.Stat(filepath.Join(dir, "index.html")); err == nil {
			return dir, nil
		}
	}
	return "", errors.New("no se encontro la carpeta 'juego'. Descomprime el .zip completo y no muevas este archivo fuera de su carpeta")
}

func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	if err := cmd.Start(); err != nil {
		fmt.Println("(No se pudo abrir el navegador automaticamente.)")
	}
}

func fail(err error) {
	fmt.Println("Error:", err)
	fmt.Println("Presiona Enter para cerrar.")
	_, _ = fmt.Scanln()
	os.Exit(1)
}
