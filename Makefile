OS := $(shell uname)

ifdef http_proxy
	DOCKER_HTTP_PROXY=--build-arg http_proxy=$(http_proxy)
endif

ifdef https_proxy
	DOCKER_HTTPS_PROXY=--build-arg https_proxy=$(https_proxy)
endif

ifdef no_proxy
	DOCKER_NO_PROXY=--build-arg no_proxy=$(no_proxy)
endif

ifdef use_proxy_at_runtime
	rt_http_proxy=$(http_proxy)
	rt_https_proxy=$(https_proxy)
	rt_no_proxy=$(no_proxy)
endif

DISABLE_CACHE = 'false'

ARCH = rpi# rpi/amd64/i386/armv7hf/armel
BASE_DISTRO =

DEPLOY_REGISTRY =

SUPERVISOR_VERSION = master
JOB_NAME = 1

all: supervisor

PUBNUB_SUBSCRIBE_KEY = sub-c-bananas
PUBNUB_PUBLISH_KEY = pub-c-bananas
MIXPANEL_TOKEN = bananasbananas

PASSWORDLESS_DROPBEAR = false

ifdef BASE_DISTRO
$(info BASE_DISTRO SPECIFIED. START BUILDING ALPINE SUPERVISOR)
	IMAGE = "resin/$(ARCH)-supervisor:$(SUPERVISOR_VERSION)-alpine"
	DOCKERFILE = alpine.$(ARCH)
else
$(info BASE_DISTRO NOT SPECIFIED. START BUILDING DEBIAN SUPERVISOR)
	IMAGE = "resin/$(ARCH)-supervisor:$(SUPERVISOR_VERSION)"
	DOCKERFILE = $(ARCH)
endif

SUPERVISOR_IMAGE=$(DEPLOY_REGISTRY)$(IMAGE)

ifeq ($(ARCH),rpi)
	GOARCH = arm
	GOARM = 6
endif
ifeq ($(ARCH),armv7hf)
	GOARCH = arm
	GOARM = 7
endif
ifeq ($(ARCH),armel)
	GOARCH = arm
	GOARM = 5
endif
ifeq ($(ARCH),i386)
	GOARCH = 386
endif
ifeq ($(ARCH),amd64)
	GOARCH = amd64
endif
SUPERVISOR_DIND_MOUNTS := -v $$(pwd)/../../:/resin-supervisor -v $$(pwd)/config.json:/mnt/conf/config.json -v $$(pwd)/config/env:/usr/src/app/config/env -v $$(pwd)/config/localenv:/usr/src/app/config/localenv
ifeq ($(OS), Linux)
	SUPERVISOR_DIND_MOUNTS := ${SUPERVISOR_DIND_MOUNTS} -v /sys/fs/cgroup:/sys/fs/cgroup:ro
endif
ifdef PRELOADED_IMAGE
	SUPERVISOR_DIND_MOUNTS := ${SUPERVISOR_DIND_MOUNTS} -v $$(pwd)/apps.json:/usr/src/app/config/apps.json
else
	PRELOADED_IMAGE=
endif

SUPERVISOR_EXTRA_MOUNTS =

clean:
	-rm Dockerfile

DOCKERD_PROXY=tools/dind/config/services/docker.service.d/proxy.conf
${DOCKERD_PROXY}:
	rm -f ${DOCKERD_PROXY}
	if [ -n "${rt_http_proxy}" ]; then \
		proxies="\"HTTP_PROXY=${rt_http_proxy}\""; \
		proxies="$${proxies[*]} \"http_proxy=${rt_http_proxy}\""; \
	fi; \
	if [ -n "${rt_https_proxy}" ]; then \
		proxies="$${proxies[*]} \"HTTPS_PROXY=${rt_https_proxy}\""; \
		proxies="$${proxies[*]} \"https_proxy=${rt_https_proxy}\""; \
	fi; \
	if [ -n "${rt_no_proxy}" ]; then \
		proxies="$${proxies[*]} \"no_proxy=${rt_no_proxy}\""; \
	fi; \
	if [ -n "${proxies}" ]; then \
		echo "[Service]" > ${DOCKERD_PROXY}; \
		echo "Environment=$${proxies[*]}" >> ${DOCKERD_PROXY}; \
	else \
		touch ${DOCKERD_PROXY}; \
	fi

supervisor-dind: ${DOCKERD_PROXY}
	cd tools/dind \
	&& docker build \
		$(DOCKER_HTTP_PROXY) \
		$(DOCKER_HTTPS_PROXY) \
		$(DOCKER_NO_PROXY) \
		--no-cache=$(DISABLE_CACHE) \
		--build-arg PASSWORDLESS_DROPBEAR=$(PASSWORDLESS_DROPBEAR) \
		-t resin/resin-supervisor-dind:$(SUPERVISOR_VERSION) .

run-supervisor: stop-supervisor supervisor-dind
	cd tools/dind \
	&& echo "SUPERVISOR_IMAGE=$(SUPERVISOR_IMAGE)" > config/localenv \
	&& echo "PRELOADED_IMAGE=$(PRELOADED_IMAGE)" >> config/localenv \
	&& echo "SUPERVISOR_EXTRA_MOUNTS=$(SUPERVISOR_EXTRA_MOUNTS)" >> config/localenv; \
	if [ -n "$(rt_http_proxy)" ]; then \
		echo "HTTP_PROXY=$(rt_http_proxy)" >> config/localenv \
		&& echo "http_proxy=$(rt_http_proxy)" >> config/localenv; \
	fi; \
	if [ -n "$(rt_https_proxy)" ]; then \
		echo "HTTPS_PROXY=$(rt_https_proxy)" >> config/localenv \
		&& echo "https_proxy=$(rt_https_proxy)" >> config/localenv; \
	fi; \
	if [ -n "$(rt_no_proxy)" ]; then \
		echo "no_proxy=$(rt_no_proxy)" >> config/localenv; \
	fi \
	&& docker run -d --name resin_supervisor_1 --privileged ${SUPERVISOR_DIND_MOUNTS} resin/resin-supervisor-dind:$(SUPERVISOR_VERSION)

stop-supervisor:
	# Stop docker and remove volumes to prevent us from running out of loopback devices,
	# as per https://github.com/jpetazzo/dind/issues/19
	-docker exec resin_supervisor_1 bash -c "systemctl stop docker" || true
	-docker stop resin_supervisor_1 > /dev/null || true
	-docker rm -f --volumes resin_supervisor_1 > /dev/null || true

refresh-supervisor-src:
	echo " * Compiling CoffeeScript.." \
	&& coffee -c ./src \
	&& echo " * Restarting supervisor container.." \
	&& docker exec -ti resin_supervisor_1 docker restart resin_supervisor

supervisor: gosuper
	cp Dockerfile.$(DOCKERFILE) Dockerfile
	echo "ENV VERSION "`jq -r .version package.json` >> Dockerfile
	echo "ENV DEFAULT_PUBNUB_PUBLISH_KEY $(PUBNUB_PUBLISH_KEY)" >> Dockerfile
	echo "ENV DEFAULT_PUBNUB_SUBSCRIBE_KEY $(PUBNUB_SUBSCRIBE_KEY)" >> Dockerfile
	echo "ENV DEFAULT_MIXPANEL_TOKEN $(MIXPANEL_TOKEN)" >> Dockerfile
ifdef rt_https_proxy
	echo "ENV HTTPS_PROXY $(rt_https_proxy)" >> Dockerfile
	echo "ENV https_proxy $(rt_https_proxy)" >> Dockerfile
endif
ifdef rt_http_proxy
	echo "ENV HTTP_PROXY $(rt_http_proxy)" >> Dockerfile
	echo "ENV http_proxy $(rt_http_proxy)" >> Dockerfile
endif
ifdef rt_no_proxy
	echo "ENV no_proxy $(rt_no_proxy)" >> Dockerfile
endif
	docker build $(DOCKER_HTTP_PROXY) $(DOCKER_HTTPS_PROXY) $(DOCKER_NO_PROXY) --no-cache=$(DISABLE_CACHE) -t $(IMAGE) .
	-rm Dockerfile

lint: supervisor
	docker run --rm --entrypoint='sh' $(IMAGE) -c 'npm install && npm run lint'

deploy: supervisor
	docker tag -f $(IMAGE) $(SUPERVISOR_IMAGE)
	bash retry_docker_push.sh $(SUPERVISOR_IMAGE)

go-builder:
	-cp tools/dind/config.json ./gosuper/
	cd gosuper && docker build $(DOCKER_HTTP_PROXY) $(DOCKER_HTTPS_PROXY) $(DOCKER_NO_PROXY) -t resin/go-supervisor-builder:$(SUPERVISOR_VERSION) .
	-rm ./gosuper/config.json

gosuper: go-builder
	-mkdir -p bin
	-docker rm --volumes -f resin_build_gosuper_$(JOB_NAME) || true
	docker run --rm --name resin_build_gosuper_$(JOB_NAME) -v $(shell pwd)/gosuper/bin:/usr/src/app/bin -e USER_ID=$(shell id -u) -e GROUP_ID=$(shell id -g) -e GOARCH=$(GOARCH) -e GOARM=$(GOARM) resin/go-supervisor-builder:$(SUPERVISOR_VERSION)
	mv gosuper/bin/linux_$(GOARCH)/gosuper bin/gosuper

test-gosuper: gosuper
	docker run \
		--rm \
		-v /var/run/dbus:/mnt/root/run/dbus \
		-e DBUS_SYSTEM_BUS_ADDRESS="unix:path=/mnt/root/run/dbus/system_bus_socket" \
		resin/go-supervisor-$(ARCH):$(SUPERVISOR_VERSION) bash -c \
			'./test_formatting.sh && go test -v ./gosuper'

format-gosuper: gosuper
	docker run \
		--rm \
		-v $(shell pwd)/gosuper:/go/src/resin-supervisor/gosuper \
		resin/go-supervisor-$(ARCH):$(SUPERVISOR_VERSION) \
			go fmt ./...

test-integration: gosuper
	docker run \
		--rm \
		--net=host \
		-e SUPERVISOR_IP="$(shell docker inspect --format '{{ .NetworkSettings.IPAddress }}' resin_supervisor_1)" \
		--volumes-from resin_supervisor_1 \
		-v /var/run/dbus:/mnt/root/run/dbus \
		-e DBUS_SYSTEM_BUS_ADDRESS="unix:path=/mnt/root/run/dbus/system_bus_socket" \
		resin/go-supervisor-$(ARCH):$(SUPERVISOR_VERSION) \
			go test -v ./supertest

.PHONY: supervisor deploy supervisor-dind run-supervisor
