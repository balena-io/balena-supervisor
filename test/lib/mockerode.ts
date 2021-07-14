import * as dockerode from 'dockerode';
import * as sinon from 'sinon';

// Recursively convert properties of an object as optional
type DeepPartial<T> = {
	[P in keyof T]?: T[P] extends Array<infer U>
		? Array<DeepPartial<U>>
		: T[P] extends object
		? DeepPartial<T[P]>
		: T[P];
};

// Partial container inspect info for receiving as testing data
export type PartialContainerInspectInfo = DeepPartial<
	dockerode.ContainerInspectInfo
> & {
	Id: string;
};

export type PartialNetworkInspectInfo = DeepPartial<
	dockerode.NetworkInspectInfo
> & {
	Id: string;
};

export type PartialVolumeInspectInfo = DeepPartial<
	dockerode.VolumeInspectInfo
> & {
	Name: string;
};

export type PartialImageInspectInfo = DeepPartial<
	dockerode.ImageInspectInfo
> & {
	Id: string;
};

type Methods<T> = {
	[K in keyof T]: T[K] extends (...args: any) => any ? T[K] : never;
};

function createFake<Prototype extends object>(prototype: Prototype) {
	return (Object.getOwnPropertyNames(prototype) as Array<keyof Prototype>)
		.filter((fn) => fn === 'constructor' || typeof prototype[fn] === 'function')
		.reduce(
			(res, fn) => ({
				...res,
				[fn]: () => {
					throw Error(
						`Fake method not implemented: ${prototype.constructor.name}.${fn}()`,
					);
				},
			}),
			{} as Methods<Prototype>,
		);
}

export function createNetwork(network: PartialNetworkInspectInfo) {
	const { Id, ...networkInspect } = network;
	const inspectInfo = {
		Id,
		Name: 'default',
		Created: '2015-01-06T15:47:31.485331387Z',
		Scope: 'local',
		Driver: 'bridge',
		EnableIPv6: false,
		Internal: false,
		Attachable: true,
		Ingress: false,
		IPAM: {
			Driver: 'default',
			Options: {},
			Config: [
				{
					Subnet: '172.18.0.0/16',
					Gateway: '172.18.0.1',
				},
			],
		},
		Containers: {},
		Options: {},
		Labels: {},

		// Add defaults
		...networkInspect,
	};

	const fakeNetwork = createFake(dockerode.Network.prototype);

	return {
		...fakeNetwork, // by default all methods fail unless overriden
		id: Id,
		inspectInfo,
		inspect: () => Promise.resolve(inspectInfo),
		remove: (): Promise<boolean> =>
			Promise.reject('Mock network not attached to an engine'),
	};
}

export type MockNetwork = ReturnType<typeof createNetwork>;

export function createContainer(container: PartialContainerInspectInfo) {
	const createContainerInspectInfo = (
		partial: PartialContainerInspectInfo,
	): dockerode.ContainerInspectInfo => {
		const {
			Id,
			State,
			Config,
			NetworkSettings,
			HostConfig,
			Mounts,
			...ContainerInfo
		} = partial;

		return {
			Id,
			Created: '2015-01-06T15:47:31.485331387Z',
			Path: '/usr/bin/sleep',
			Args: ['infinity'],
			State: {
				Status: 'running',
				ExitCode: 0,
				Running: true,
				Paused: false,
				Restarting: false,
				OOMKilled: false,
				...State, // User passed options
			},
			Image: 'deadbeef',
			Name: 'main',
			HostConfig: {
				AutoRemove: false,
				Binds: [],
				LogConfig: {
					Type: 'journald',
					Config: {},
				},
				NetworkMode: 'bridge',
				PortBindings: {},
				RestartPolicy: {
					Name: 'always',
					MaximumRetryCount: 0,
				},
				VolumeDriver: '',
				CapAdd: [],
				CapDrop: [],
				Dns: [],
				DnsOptions: [],
				DnsSearch: [],
				ExtraHosts: [],
				GroupAdd: [],
				IpcMode: 'shareable',
				Privileged: false,
				SecurityOpt: [],
				ShmSize: 67108864,
				Memory: 0,
				MemoryReservation: 0,
				OomKillDisable: false,
				Devices: [],
				Ulimits: [],
				...HostConfig, // User passed options
			},
			Config: {
				Hostname: Id,
				Labels: {},
				Cmd: ['/usr/bin/sleep', 'infinity'],
				Env: [] as string[],
				Volumes: {},
				Image: 'alpine:latest',
				...Config, // User passed options
			},
			NetworkSettings: {
				Networks: {
					default: {
						Aliases: [],
						Gateway: '172.18.0.1',
						IPAddress: '172.18.0.2',
						IPPrefixLen: 16,
						MacAddress: '00:00:de:ad:be:ef',
					},
				},
				...NetworkSettings, // User passed options
			},
			Mounts: [
				...(Mounts || []).map(({ Name, ...opts }) => ({
					Name,
					Type: 'volume',
					Source: `/var/lib/docker/volumes/${Name}/_data`,
					Destination: '/opt/${Name}/path',
					Driver: 'local',
					Mode: '',
					RW: true,
					Propagation: '',

					// Replace defaults
					...opts,
				})),
			],

			...ContainerInfo,
		} as dockerode.ContainerInspectInfo;
	};

	const createContainerInfo = (
		containerInspectInfo: dockerode.ContainerInspectInfo,
	): dockerode.ContainerInfo => {
		const {
			Id,
			Name,
			Created,
			Image,
			State,
			HostConfig,
			Config,
			Mounts,
			NetworkSettings,
		} = containerInspectInfo;

		const capitalizeFirst = (s: string) =>
			s.charAt(0).toUpperCase() + s.slice(1);

		// Calculate summary from existing inspectInfo object
		return {
			Id,
			Names: [Name],
			ImageID: Image,
			Image: Config.Image,
			Created: Date.parse(Created),
			Command: Config.Cmd.join(' '),
			State: capitalizeFirst(State.Status),
			Status: `Exit ${State.ExitCode}`,
			HostConfig: {
				NetworkMode: HostConfig.NetworkMode!,
			},
			Ports: [],
			Labels: Config.Labels,
			NetworkSettings: {
				Networks: NetworkSettings.Networks,
			},
			Mounts: Mounts as dockerode.ContainerInfo['Mounts'],
		};
	};

	const inspectInfo = createContainerInspectInfo(container);
	const info = createContainerInfo(inspectInfo);

	const { Id: id } = inspectInfo;

	const fakeContainer = createFake(dockerode.Container.prototype);

	return {
		...fakeContainer, // by default all methods fail unless overriden
		id,
		inspectInfo,
		info,
		inspect: () => Promise.resolve(inspectInfo),
		remove: (): Promise<boolean> =>
			Promise.reject('Mock container not attached to an engine'),
	};
}

export type MockContainer = ReturnType<typeof createContainer>;

interface Reference {
	repository: string;
	tag?: string;
	digest?: string;
	toString: () => string;
}

const parseReference = (uri: string): Reference => {
	// https://github.com/docker/distribution/blob/release/2.7/reference/normalize.go#L62
	// https://github.com/docker/distribution/blob/release/2.7/reference/regexp.go#L44
	const match = uri.match(
		/^(?:(localhost|.*?[.:].*?)\/)?(.+?)(?::(.*?))?(?:@(.*?))?$/,
	);

	if (!match) {
		throw new Error(`Could not parse the image: ${uri}`);
	}

	const [, registry, imageName, tagName, digest] = match;

	let tag = tagName;
	if (!digest && !tag) {
		tag = 'latest';
	}

	const digestMatch = digest?.match(
		/^[A-Za-z][A-Za-z0-9]*(?:[-_+.][A-Za-z][A-Za-z0-9]*)*:[0-9a-f-A-F]{32,}$/,
	);
	if (!imageName || (digest && !digestMatch)) {
		throw new Error(
			'Invalid image name, expected [domain.tld/]repo/image[:tag][@digest] format',
		);
	}

	const repository = [registry, imageName].filter((s) => !!s).join('/');

	return {
		repository,
		tag,
		digest,
		toString: () =>
			repository +
			(tagName ? `:${tagName}` : '') +
			(digest ? `@${digest}` : ''),
	};
};

export function createImage(
	// Do not allow RepoTags or RepoDigests to be provided.
	// References must be used instead
	image: Omit<PartialImageInspectInfo, 'RepoTags' | 'RepoDigests'>,
	{ References = [] as string[] } = {},
) {
	const createImageInspectInfo = (
		partialImage: PartialImageInspectInfo,
	): dockerode.ImageInspectInfo => {
		const {
			Id,
			ContainerConfig,
			Config,
			GraphDriver,
			RootFS,
			...Info
		} = partialImage;

		return {
			Id,
			RepoTags: [],
			RepoDigests: [
				'registry2.resin.io/v2/8ddbe4a22e881f06def0f31400bfb6de@sha256:09b0db9e71cead5f91107fc9254b1af7088444cc6da55afa2da595940f72a34a',
			],
			Parent: '',
			Comment: 'Not a real image',
			Created: '2018-08-15T12:43:06.43392045Z',
			Container:
				'b6cc9227f272b905512a58926b6d515b38de34b604386031aa3c21e94d9dbb4a',
			ContainerConfig: {
				Hostname: 'f15babe8256c',
				Domainname: '',
				User: '',
				AttachStdin: false,
				AttachStdout: false,
				AttachStderr: false,
				Tty: false,
				OpenStdin: false,
				StdinOnce: false,
				Env: [
					'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
				],
				Cmd: ['/usr/bin/sleep', 'infinity'],
				ArgsEscaped: true,
				Image:
					'sha256:828d725f5e6d09ee9abc214f6c11fadf69192ba4871b050984cc9c4cec37b208',
				Volumes: {},
				WorkingDir: '',
				Entrypoint: null,
				OnBuild: null,
				Labels: {},

				...ContainerConfig,
			} as dockerode.ImageInspectInfo['ContainerConfig'],
			DockerVersion: '17.05.0-ce',
			Author: '',
			Config: {
				Hostname: '',
				Domainname: '',
				User: '',
				AttachStdin: false,
				AttachStdout: false,
				AttachStderr: false,
				Tty: false,
				OpenStdin: false,
				StdinOnce: false,
				Env: [
					'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
				],
				Cmd: ['/usr/bin/sleep', 'infinity'],
				ArgsEscaped: true,
				Image:
					'sha256:828d725f5e6d09ee9abc214f6c11fadf69192ba4871b050984cc9c4cec37b208',
				Volumes: {},
				WorkingDir: '/usr/src/app',
				Entrypoint: ['/usr/bin/entry.sh'],
				OnBuild: [],
				Labels: {
					...(Config?.Labels ?? {}),
				},
				...Config,
			} as dockerode.ImageInspectInfo['Config'],

			Architecture: 'arm64',
			Os: 'linux',
			Size: 38692178,
			VirtualSize: 38692178,
			GraphDriver: {
				Data: {
					DeviceId: 'deadbeef',
					DeviceName: 'dummy',
					DeviceSize: '10m',
				},
				Name: 'aufs',

				...GraphDriver,
			} as dockerode.ImageInspectInfo['GraphDriver'],
			RootFS: {
				Type: 'layers',
				Layers: [
					'sha256:7c30ac6ce381873d5388b7d23b346af7d1e5f6af000a84b97e6203ed9e6dcab2',
					'sha256:450b73019ae79e6a99774fcd37c18769f95065c8b271be936dfb3f93afadc4a8',
					'sha256:6ab67aaf666bfb7001ab93deffe785f24775f4e0da3d6d421ad6096ba869fd0d',
				],

				...RootFS,
			} as dockerode.ImageInspectInfo['RootFS'],

			...Info,
		};
	};

	const createImageInfo = (imageInspectInfo: dockerode.ImageInspectInfo) => {
		const {
			Id,
			Parent: ParentId,
			RepoTags,
			RepoDigests,
			Config,
		} = imageInspectInfo;

		const { Labels } = Config;

		return {
			Id,
			ParentId,
			RepoTags,
			RepoDigests,
			Created: 1474925151,
			Size: 103579269,
			VirtualSize: 103579269,
			SharedSize: 0,
			Labels,
			Containers: 0,
		};
	};

	const references = References.map((uri) => parseReference(uri));

	// Generate image repo tags and digests for inspect
	const { tags, digests } = references.reduce(
		(pairs, ref) => {
			if (ref.tag) {
				pairs.tags.push([ref.repository, ref.tag].join(':'));
			}

			if (ref.digest) {
				pairs.digests.push([ref.repository, ref.digest].join('@'));
			}

			return pairs;
		},
		{ tags: [] as string[], digests: [] as string[] },
	);

	const inspectInfo = createImageInspectInfo({
		...image,

		// Use references to fill RepoTags and RepoDigests ignoring
		// those from the partial inspect info
		RepoTags: [...new Set([...tags])],
		RepoDigests: [...new Set([...digests])],
	});
	const info = createImageInfo(inspectInfo);
	const { Id: id } = inspectInfo;

	const fakeImage = createFake(dockerode.Image.prototype);

	return {
		...fakeImage, // by default all methods fail unless overriden
		id,
		info,
		inspectInfo,
		references,
		inspect: () => Promise.resolve(inspectInfo),
		remove: (_opts: any): Promise<boolean> =>
			Promise.reject('Mock image not attached to an engine'),
	};
}

export type MockImage = ReturnType<typeof createImage>;

export function createVolume(volume: PartialVolumeInspectInfo) {
	const { Name, Labels, ...partialVolumeInfo } = volume;

	const inspectInfo: dockerode.VolumeInspectInfo = {
		Name,
		Driver: 'local',
		Mountpoint: '/var/lib/docker/volumes/resin-data',
		Labels: {
			...Labels,
		} as dockerode.VolumeInspectInfo['Labels'],
		Scope: 'local',
		Options: {},

		...partialVolumeInfo,
	};

	const fakeVolume = createFake(dockerode.Volume.prototype);
	return {
		...fakeVolume, // by default all methods fail unless overriden
		name: Name,
		inspectInfo,
		inspect: () => Promise.resolve(inspectInfo),
		remove: (): Promise<boolean> =>
			Promise.reject('Mock volume not attached to an engine'),
	};
}

export type MockVolume = ReturnType<typeof createVolume>;

export type MockEngineState = {
	containers?: MockContainer[];
	networks?: MockNetwork[];
	volumes?: MockVolume[];
	images?: MockImage[];
};

// Good enough function go generate ids for mock engine
// source: https://stackoverflow.com/a/2117523
function uuidv4() {
	return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
		// tslint:disable
		const r = (Math.random() * 16) | 0,
			v = c == 'x' ? r : (r & 0x3) | 0x8;
		return v.toString(16);
	});
}

type Stubs<T> = {
	[K in keyof T]: T[K] extends (...args: infer TArgs) => infer TReturnValue
		? sinon.SinonStub<TArgs, TReturnValue>
		: never;
};

export class MockEngine {
	networks: Dictionary<MockNetwork> = {};
	containers: Dictionary<MockContainer> = {};
	images: Dictionary<MockImage> = {};
	volumes: Dictionary<MockVolume> = {};

	constructor({
		networks = [],
		containers = [],
		images = [],
		volumes = [],
	}: MockEngineState) {
		// Key networks by id
		this.networks = networks.reduce((networkMap, network) => {
			const { id } = network;

			return {
				...networkMap,
				[id]: { ...network, remove: () => this.removeNetwork(id) },
			};
		}, {});

		this.containers = containers.reduce((containerMap, container) => {
			const { id } = container;
			return {
				...containerMap,
				[id]: {
					...container,
					remove: () => this.removeContainer(id),
				},
			};
		}, {});

		this.images = images.reduce((imageMap, image) => {
			const { id } = image;

			return {
				...imageMap,
				[id]: {
					...image,
					remove: (options: any) => this.removeImage(id, options),
				},
			};
		}, {});

		this.volumes = volumes.reduce((volumeMap, volume) => {
			const { name } = volume;

			return {
				...volumeMap,
				[name]: {
					...volume,
					remove: () => this.removeVolume(name),
				},
			};
		}, {});
	}

	getNetwork(id: string) {
		const network = Object.values(this.networks).find(
			(n) => n.inspectInfo.Id === id || n.inspectInfo.Name === id,
		);

		if (!network) {
			return {
				id,
				inspect: () =>
					Promise.reject({ statusCode: 404, message: `No such network ${id}` }),
				remove: () =>
					Promise.reject({ statusCode: 404, message: `No such network ${id}` }),
			} as MockNetwork;
		}

		return network;
	}

	listNetworks() {
		return Promise.resolve(
			Object.values(this.networks).map((network) => network.inspectInfo),
		);
	}

	removeNetwork(id: string) {
		const network = Object.values(this.networks).find(
			(n) => n.inspectInfo.Id === id || n.inspectInfo.Name === id,
		);

		// Throw an error if the network does not exist
		// this should never happen
		if (!network) {
			return Promise.reject({
				statusCode: 404,
				message: `No such network ${id}`,
			});
		}

		return Promise.resolve(delete this.networks[network.id]);
	}

	createNetwork(options: dockerode.NetworkCreateOptions) {
		const Id = uuidv4();
		const network = createNetwork({ Id, ...options });

		// Add to the list
		this.networks[Id] = network;
	}

	listContainers() {
		return Promise.resolve(
			// List containers returns ContainerInfo objects so we return summaries
			Object.values(this.containers).map((container) => container.info),
		);
	}

	createContainer(options: dockerode.ContainerCreateOptions) {
		const Id = uuidv4();

		const { name: Name, HostConfig, NetworkingConfig, ...Config } = options;

		const container = createContainer({
			Id,
			Name,
			HostConfig,
			Config,
			NetworkSettings: { Networks: NetworkingConfig?.EndpointsConfig ?? {} },
			State: { Status: 'created' },
		});

		// Add to the list
		this.containers[Id] = {
			...container,
			remove: () => this.removeContainer(Id),
		};
	}

	getContainer(id: string) {
		const container = Object.values(this.containers).find(
			(c) => c.inspectInfo.Id === id || c.inspectInfo.Name === id,
		);

		if (!container) {
			return {
				id,
				inspect: () =>
					Promise.reject({
						statusCode: 404,
						message: `No such container ${id}`,
					}),
			} as MockContainer;
		}

		return { ...container, remove: () => this.removeContainer(id) };
	}

	removeContainer(id: string) {
		const container = Object.values(this.containers).find(
			(c) => c.inspectInfo.Id === id || c.inspectInfo.Name === id,
		);

		// Throw an error if the container does not exist
		// this should never happen
		if (!container) {
			return Promise.reject({
				statusCode: 404,
				message: `No such container ${id}`,
			});
		}

		return Promise.resolve(delete this.containers[container.id]);
	}

	listImages({ filters = { reference: [] as string[] } } = {}) {
		const filterList = [] as ((img: MockImage) => boolean)[];
		const transformers = [] as ((img: MockImage) => MockImage)[];

		// Add reference filters
		if (filters.reference?.length > 0) {
			const isMatchingReference = ({ repository, tag }: Reference) =>
				filters.reference.includes(repository) ||
				filters.reference.includes(
					[repository, tag].filter((s) => !!s).join(':'),
				);

			// Create a filter for images matching the reference
			filterList.push((img) => img.references.some(isMatchingReference));

			// Create a transformer removing unused references from the image
			transformers.push((img) =>
				createImage(img.inspectInfo, {
					References: img.references
						.filter(isMatchingReference)
						.map((ref) => ref.toString()),
				}),
			);
		}

		return Promise.resolve(
			Object.values(this.images)
				// Remove images that do not match the filter
				.filter((img) => filterList.every((fn) => fn(img)))
				// Transform the image if needed
				.map((image) => transformers.reduce((img, next) => next(img), image))
				.map((image) => image.info),
		);
	}

	getVolume(name: string) {
		const volume = Object.values(this.volumes).find((v) => v.name === name);

		if (!volume) {
			return {
				name,
				inspect: () =>
					Promise.reject({
						statusCode: 404,
						message: `No such volume ${name}`,
					}),
				remove: () =>
					Promise.reject({
						statusCode: 404,
						message: `No such volume ${name}`,
					}),
			};
		}

		return volume;
	}

	listVolumes() {
		return Promise.resolve({
			Volumes: Object.values(this.volumes).map((volume) => volume.inspectInfo),
			Warnings: [] as string[],
		});
	}

	removeVolume(name: string) {
		return Promise.resolve(delete this.volumes[name]);
	}

	createVolume(options: PartialVolumeInspectInfo) {
		const { Name } = options;
		const volume = createVolume(options);

		// Add to the list
		this.volumes[Name] = volume;
	}

	// NOT a dockerode method
	// Implements this https://docs.docker.com/engine/reference/commandline/rmi/
	// Removes (and un-tags) one or more images from the host node.
	// If an image has multiple tags, using this command with the tag as
	// a parameter only removes the tag. If the tag is the only one for the image,
	// both the image and the tag are removed.
	// Does not remove images from a registry.
	// You cannot remove an image of a running container unless you use the
	// -f option. To see all images on a host use the docker image ls command.
	//
	// You can remove an image using its short or long ID, its tag, or its digest.
	// If an image has one or more tags referencing it, you must remove all of them
	// before the image is removed. Digest references are removed automatically when
	// an image is removed by tag.
	removeImage(name: string, { force } = { force: false }) {
		const image = this.findImage(name);
		console.log('REMOVE', name);

		// Throw an error if the image does not exist
		if (!image) {
			return Promise.reject({
				statusCode: 404,
				message: `No such image ${name}`,
			});
		}

		// Get the id of the iamge
		const { Id: id } = image.inspectInfo;

		// If the given identifier is an id
		if (id === name) {
			if (!force && image.references.length > 1) {
				// If the name is an id and there are multiple tags
				// or digests referencing the image, don't delete unless the force option
				return Promise.reject({
					statusCode: 409,
					message: `Unable to delete image ${name} with multiple references`,
				});
			}

			return Promise.resolve(delete this.images[id]);
		}

		// If the name is not an id, then it must be a reference
		const ref = parseReference(name);

		const References = image.references
			.filter(
				(r) =>
					r.repository !== ref.repository ||
					(r.digest !== ref.digest && r.tag !== ref.tag),
			)
			.map((r) => r.toString());

		if (References.length > 0) {
			// If there are still digests or tags, just update the stored image
			this.images[id] = {
				...createImage(image.inspectInfo, { References }),
				remove: (options: any) => this.removeImage(id, options),
			};

			return Promise.resolve(true);
		}

		// Remove the original image
		return Promise.resolve(delete this.images[id]);
	}

	private findImage(name: string) {
		if (this.images[name]) {
			return this.images[name];
		}

		// If the identifier is not an id it must be a reference
		const ref = parseReference(name);

		return Object.values(this.images).find((img) =>
			img.references.some(
				(r) =>
					// Find an image that has a reference with matching digest or tag
					r.repository === ref.repository &&
					(r.digest === ref.digest || r.tag === ref.tag),
			),
		);
	}

	getImage(name: string) {
		const image = this.findImage(name);

		// If the image doesn't exist return an empty object
		if (!image) {
			return {
				id: name,
				inspect: () =>
					Promise.reject({ statusCode: 404, message: `No such image ${name}` }),
				remove: () =>
					Promise.reject({ statusCode: 404, message: `No such image ${name}` }),
			};
		}

		return {
			...image,
			remove: (options: any) => this.removeImage(name, options),
		};
	}

	getEvents() {
		console.log(`Calling mockerode.getEvents 🐳`);
		return Promise.resolve({ on: () => void 0, pipe: () => void 0 });
	}
}

export function createMockerode(engine: MockEngine) {
	const dockerodeStubs: Stubs<dockerode> = (Object.getOwnPropertyNames(
		dockerode.prototype,
	) as (keyof dockerode)[])
		.filter((fn) => typeof dockerode.prototype[fn] === 'function')
		.reduce((stubMap, fn) => {
			const stub = sinon.stub(dockerode.prototype, fn);

			if (MockEngine.prototype.hasOwnProperty(fn)) {
				stub.callsFake((MockEngine.prototype as any)[fn].bind(engine));
			} else {
				// By default all unimplemented methods will throw to avoid the tests
				// silently failing
				stub.throws(`Not implemented: Dockerode.${fn}`);
			}

			return { ...stubMap, [fn]: stub };
		}, {} as Stubs<dockerode>);

	const { removeImage, removeNetwork, removeVolume, removeContainer } = engine;

	// Add stubs to additional engine methods we want to
	// be able to check
	const mockEngineStubs = {
		removeImage: sinon
			.stub(engine, 'removeImage')
			.callsFake(removeImage.bind(engine)),
		removeNetwork: sinon
			.stub(engine, 'removeNetwork')
			.callsFake(removeNetwork.bind(engine)),
		removeVolume: sinon
			.stub(engine, 'removeVolume')
			.callsFake(removeVolume.bind(engine)),
		removeContainer: sinon
			.stub(engine, 'removeContainer')
			.callsFake(removeContainer.bind(engine)),
	};

	return {
		...dockerodeStubs,
		...mockEngineStubs,
		restore: () => {
			Object.values(dockerodeStubs).forEach((stub) => stub.restore());
			Object.values(mockEngineStubs).forEach((spy) => spy.restore());
		},
		resetHistory: () => {
			Object.values(dockerodeStubs).forEach((stub) => stub.resetHistory());
			Object.values(mockEngineStubs).forEach((spy) => spy.resetHistory());
		},
	};
}

export type Mockerode = ReturnType<typeof createMockerode>;

export async function withMockerode(
	test: (dockerode: Mockerode) => Promise<any>,
	initialState: MockEngineState = {
		containers: [],
		networks: [],
		volumes: [],
		images: [],
	},
) {
	const mockEngine = new MockEngine(initialState);
	const mockerode = createMockerode(mockEngine);

	try {
		// run the tests
		await test(mockerode);
	} finally {
		// restore stubs always
		mockerode.restore();
	}
}
