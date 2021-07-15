import { promises as fs } from 'fs';
import { SinonStub, stub } from 'sinon';

import { expect } from 'chai';
import * as fsUtils from '../src/lib/fs-utils';
import { SplashImage } from '../src/config/backends/splash-image';
import log from '../src/lib/supervisor-console';

describe('Splash image configuration', () => {
	const backend = new SplashImage();
	const defaultLogo =
		'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQMAAAAl21bKAAAAA1BMVEX/wQDLA+84AAAACklEQVR4nGNiAAAABgADNjd8qAAAAABJRU5ErkJggg==';
	const logo =
		'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQMAAAAl21bKAAAAA1BMVEX/TQBcNTh/AAAAAXRSTlPM0jRW/QAAAApJREFUeJxjYgAAAAYAAzY3fKgAAAAASUVORK5CYII=';
	const uri = `data:image/png;base64,${logo}`;
	let readDirStub: SinonStub;
	let readFileStub: SinonStub;
	let writeFileAtomicStub: SinonStub;

	before(() => {
		writeFileAtomicStub = stub(fsUtils, 'writeFileAtomic');
		stub(fsUtils, 'exec');
		readFileStub = stub(fs, 'readFile');
		readDirStub = stub(fs, 'readdir');
	});

	beforeEach(() => {
		// Setup stubs
		writeFileAtomicStub.resolves();
		(fsUtils.exec as SinonStub).resolves();
		readFileStub.resolves(Buffer.from(logo, 'base64') as any);
		readFileStub
			.withArgs('test/data/mnt/boot/splash/balena-logo-default.png')
			.resolves(Buffer.from(defaultLogo, 'base64') as any);
		readDirStub.resolves(['balena-logo.png'] as any);
	});

	afterEach(() => {
		// Reset stubs
		writeFileAtomicStub.reset();
		(fsUtils.exec as SinonStub).reset();
		readFileStub.reset();
		readDirStub.reset();
	});

	after(() => {
		// Restore stubs
		writeFileAtomicStub.restore();
		(fsUtils.exec as SinonStub).restore();
		readFileStub.restore();
		readDirStub.restore();
	});

	describe('initialise', () => {
		it('should make a copy of the existing boot image on initialise if not yet created', async () => {
			stub(fsUtils, 'exists').resolves(false);

			// Do the initialization
			await backend.initialise();

			expect(fs.readFile).to.be.calledOnceWith(
				'test/data/mnt/boot/splash/balena-logo.png',
			);

			// Should make a copy
			expect(writeFileAtomicStub).to.be.calledOnceWith(
				'test/data/mnt/boot/splash/balena-logo-default.png',
				Buffer.from(logo, 'base64'),
			);

			(fsUtils.exists as SinonStub).restore();
		});

		it('should skip initialization if the default image already exists', async () => {
			stub(fsUtils, 'exists').resolves(true);

			// Do the initialization
			await backend.initialise();

			expect(fsUtils.exists).to.be.calledOnceWith(
				'test/data/mnt/boot/splash/balena-logo-default.png',
			);
			expect(fs.readFile).to.not.have.been.called;

			(fsUtils.exists as SinonStub).restore();
		});

		it('should fail initialization if there is no default image on the device', async () => {
			stub(fsUtils, 'exists').resolves(false);
			readDirStub.resolves([]);
			readFileStub.rejects();
			stub(log, 'warn');

			// Do the initialization
			await backend.initialise();

			expect(readDirStub).to.be.calledOnce;
			expect(fs.readFile).to.have.been.calledOnce;
			expect(log.warn).to.be.calledOnce;

			(log.warn as SinonStub).restore();
		});
	});

	describe('getBootConfig', () => {
		it('should return an empty object if the current logo matches the default logo', async () => {
			readDirStub.resolves(['resin-logo.png']);

			// The default logo resolves to the same value as the current logo
			readFileStub
				.withArgs('test/data/mnt/boot/splash/balena-logo-default.png')
				.resolves(logo);

			expect(await backend.getBootConfig()).to.deep.equal({});
			expect(readDirStub).to.be.calledOnce;
			expect(readFileStub).to.be.calledTwice;
			expect(readFileStub).to.be.calledWith(
				'test/data/mnt/boot/splash/balena-logo-default.png',
			);
			expect(readFileStub).to.be.calledWith(
				'test/data/mnt/boot/splash/resin-logo.png',
			);
		});

		it('should read the splash image from resin-logo.png if available', async () => {
			readDirStub.resolves(['resin-logo.png']);

			expect(await backend.getBootConfig()).to.deep.equal({
				image: uri,
			});
			expect(readDirStub).to.be.calledOnce;
			expect(readFileStub).to.be.calledTwice;
			expect(readFileStub).to.be.calledWith(
				'test/data/mnt/boot/splash/balena-logo-default.png',
			);
			expect(readFileStub).to.be.calledWith(
				'test/data/mnt/boot/splash/resin-logo.png',
			);
		});

		it('should read the splash image from balena-logo.png if available', async () => {
			readDirStub.resolves(['balena-logo.png']);

			expect(await backend.getBootConfig()).to.deep.equal({
				image: uri,
			});
			expect(readDirStub).to.be.calledOnce;
			expect(readFileStub).to.be.calledTwice;
			expect(readFileStub).to.be.calledWith(
				'test/data/mnt/boot/splash/balena-logo-default.png',
			);
			expect(readFileStub).to.be.calledWith(
				'test/data/mnt/boot/splash/balena-logo.png',
			);
		});

		it('should read the splash image from balena-logo.png even if resin-logo.png exists', async () => {
			readDirStub.resolves(['balena-logo.png', 'resin-logo.png']);

			expect(await backend.getBootConfig()).to.deep.equal({
				image: uri,
			});
			expect(readFileStub).to.be.calledTwice;
			expect(readFileStub).to.be.calledWith(
				'test/data/mnt/boot/splash/balena-logo-default.png',
			);
			expect(readFileStub).to.be.calledWith(
				'test/data/mnt/boot/splash/balena-logo.png',
			);
		});

		it('should catch readDir errors', async () => {
			stub(log, 'warn');
			readDirStub.rejects();

			expect(await backend.getBootConfig()).to.deep.equal({});
			expect(readDirStub).to.be.calledOnce;
			expect(log.warn).to.be.calledOnce;

			(log.warn as SinonStub).restore();
		});

		it('should catch readFile errors', async () => {
			stub(log, 'warn');
			readDirStub.resolves([]);
			readFileStub.rejects();

			expect(await backend.getBootConfig()).to.deep.equal({});
			expect(log.warn).to.be.calledOnce;

			(log.warn as SinonStub).restore();
		});
	});

	describe('setBootConfig', () => {
		it('should write the given image to resin-logo.png if set', async () => {
			readDirStub.resolves(['resin-logo.png']);

			await backend.setBootConfig({ image: uri });

			expect(readDirStub).to.be.calledOnce;
			expect(writeFileAtomicStub).to.be.calledOnceWith(
				'test/data/mnt/boot/splash/resin-logo.png',
				Buffer.from(logo, 'base64'),
			);
		});

		it('should write the given image to balena-logo.png if set', async () => {
			readDirStub.resolves(['balena-logo.png']);

			await backend.setBootConfig({ image: uri });

			expect(readDirStub).to.be.calledOnce;
			expect(writeFileAtomicStub).to.be.calledOnceWith(
				'test/data/mnt/boot/splash/balena-logo.png',
				Buffer.from(logo, 'base64'),
			);
		});

		it('should write the given image to balena-logo.png by default', async () => {
			readDirStub.resolves([]);

			await backend.setBootConfig({ image: uri });

			expect(readDirStub).to.be.calledOnce;
			expect(writeFileAtomicStub).to.be.calledOnceWith(
				'test/data/mnt/boot/splash/balena-logo.png',
				Buffer.from(logo, 'base64'),
			);
		});

		it('should accept just a base64 as an image', async () => {
			readDirStub.resolves(['balena-logo.png']);

			await backend.setBootConfig({ image: logo });

			expect(readDirStub).to.be.calledOnce;
			expect(writeFileAtomicStub).to.be.calledOnceWith(
				'test/data/mnt/boot/splash/balena-logo.png',
				Buffer.from(logo, 'base64'),
			);
		});

		it('should restore balena-logo.png if image arg is unset', async () => {
			readDirStub.resolves(['balena-logo.png']);
			await backend.setBootConfig({});

			expect(readDirStub).to.be.calledOnce;
			expect(readFileStub).to.be.calledOnceWith(
				'test/data/mnt/boot/splash/balena-logo-default.png',
			);
			expect(writeFileAtomicStub).to.be.calledOnceWith(
				'test/data/mnt/boot/splash/balena-logo.png',
				Buffer.from(defaultLogo, 'base64'),
			);
		});

		it('should restore resin-logo.png if image arg is unset', async () => {
			readDirStub.resolves(['resin-logo.png']);
			await backend.setBootConfig({});

			expect(readDirStub).to.be.calledOnce;
			expect(readFileStub).to.be.calledOnceWith(
				'test/data/mnt/boot/splash/balena-logo-default.png',
			);
			expect(writeFileAtomicStub).to.be.calledOnceWith(
				'test/data/mnt/boot/splash/resin-logo.png',
				Buffer.from(defaultLogo, 'base64'),
			);
		});

		it('should restore balena-logo.png if image arg is empty', async () => {
			readDirStub.resolves(['balena-logo.png']);
			await backend.setBootConfig({ image: '' });

			expect(readDirStub).to.be.calledOnce;
			expect(readFileStub).to.be.calledOnceWith(
				'test/data/mnt/boot/splash/balena-logo-default.png',
			);
			expect(writeFileAtomicStub).to.be.calledOnceWith(
				'test/data/mnt/boot/splash/balena-logo.png',
				Buffer.from(defaultLogo, 'base64'),
			);
		});

		it('should restore resin-logo.png if image arg is empty', async () => {
			readDirStub.resolves(['resin-logo.png']);
			await backend.setBootConfig({ image: '' });

			expect(readDirStub).to.be.calledOnce;
			expect(readFileStub).to.be.calledOnceWith(
				'test/data/mnt/boot/splash/balena-logo-default.png',
			);
			expect(writeFileAtomicStub).to.be.calledOnceWith(
				'test/data/mnt/boot/splash/resin-logo.png',
				Buffer.from(defaultLogo, 'base64'),
			);
		});

		it('should throw if arg is not a valid base64 string', async () => {
			expect(backend.setBootConfig({ image: 'somestring' })).to.be.rejected;
			expect(writeFileAtomicStub).to.not.be.called;
		});

		it('should throw if image is not a valid PNG file', async () => {
			expect(backend.setBootConfig({ image: 'aGVsbG8=' })).to.be.rejected;
			expect(writeFileAtomicStub).to.not.be.called;
		});
	});

	describe('isBootConfigVar', () => {
		it('Accepts any case variable names', () => {
			expect(backend.isBootConfigVar('HOST_SPLASH_IMAGE')).to.be.true;
			expect(backend.isBootConfigVar('HOST_SPLASH_image')).to.be.true;
			expect(backend.isBootConfigVar('HOST_SPLASH_Image')).to.be.true;
			expect(backend.isBootConfigVar('HOST_SPLASH_ImAgE')).to.be.true;
		});
	});
});
