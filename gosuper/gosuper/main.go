package main

import (
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"time"

	"resin-supervisor/gosuper/Godeps/_workspace/src/github.com/gorilla/mux"
	"resin-supervisor/gosuper/psutils"
)

var ResinDataPath string = "/mnt/root/resin-data/"

func setupApi(router *mux.Router) {
	router.HandleFunc("/ping", func(writer http.ResponseWriter, request *http.Request) {
		fmt.Fprintln(writer, "OK")
	})

	apiv1 := router.PathPrefix("/v1").Subrouter()
	apiv1.HandleFunc("/ipaddr", IPAddressHandler).Methods("GET")
	apiv1.HandleFunc("/purge", PurgeHandler).Methods("POST")
	apiv1.HandleFunc("/reboot", RebootHandler).Methods("POST")
	apiv1.HandleFunc("/shutdown", ShutdownHandler).Methods("POST")
	apiv1.HandleFunc("/vpncontrol", VPNControl).Methods("POST")
}

func startApi(listenAddress string, router *mux.Router) {
	if listener, err := net.Listen("unix", listenAddress); err != nil {
		log.Fatalf("Could not listen on %s: %v", listenAddress, err)
	} else {
		log.Printf("Starting HTTP server on %s\n", listenAddress)
		if err = http.Serve(listener, router); err != nil {
			log.Fatalf("Could not start HTTP server: %v", err)
		}
	}
}

func startServiceOOMProtection(hostproc string) {
	err := psutils.AdjustOOMPriorityByName(hostproc, "openvpn", -1000)
	if err != nil {
		log.Printf(err.Error())
	}
	err = psutils.AdjustOOMPriorityByName(hostproc, "connmand", -1000)
	if err != nil {
		log.Printf(err.Error())
	}
}

func startOOMProtection(hostproc string, dockerSocket string, ticker *time.Ticker) {
	log.Println("Changing OOMScore Adjust Value for this container to -800")
	err := psutils.AdjustDockerOOMPriority(hostproc, "unix://"+dockerSocket, "resin-supervisor", -800)
	if err != nil {
		log.Printf(err.Error())
	}
	log.Println("Changing OOMScore Adjust Value for openvpn and connmand to -1000 every 5 minutes")
	startServiceOOMProtection(hostproc)
	go func() {
		for _ = range ticker.C {
			startServiceOOMProtection(hostproc)
		}
	}()
}

func main() {
	log.SetFlags(log.Lshortfile | log.LstdFlags)
	log.Println("Resin Go Supervisor starting")

	// Start ticker for protecting Openvpn/Connman every 5 minutes
	ticker := time.NewTicker(time.Minute * 5)
	defer ticker.Stop()
	dockerSocket := os.Getenv("DOCKER_SOCKET")
	hostproc := os.Getenv("HOST_PROC")
	startOOMProtection(hostproc, dockerSocket, ticker)

	listenAddress := os.Getenv("GOSUPER_SOCKET")
	router := mux.NewRouter()
	setupApi(router)
	startApi(listenAddress, router)
}
