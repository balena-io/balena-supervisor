import { expect } from 'chai';
import * as path from 'path';
import { promises as fs } from 'fs';
import { spy, SinonSpy } from 'sinon';
import * as mockFs from 'mock-fs';

import * as fsUtils from '../../../src/lib/fs-utils';
import { rootMountPoint } from '../../../src/lib/constants';

describe('lib/fs-utils', () => {
	const testFileName1 = 'file.1';
	const testFileName2 = 'file.2';
	const testFile1 = path.join(rootMountPoint, testFileName1);
	const testFile2 = path.join(rootMountPoint, testFileName2);

	beforeEach(() =>
		mockFs({
			[testFile1]: 'foo',
			[testFile2]: 'bar',
		}),
	);

	afterEach(mockFs.restore);

	describe('writeAndSyncFile', () => {
		it('should write and sync string data', async () => {
			await fsUtils.writeAndSyncFile(testFile1, 'foo bar');
			expect(await fs.readFile(testFile1, 'utf-8')).to.equal('foo bar');
		});

		it('should write and sync buffers', async () => {
			await fsUtils.writeAndSyncFile(testFile1, Buffer.from('bar foo'));
			expect(await fs.readFile(testFile1, 'utf-8')).to.equal('bar foo');
		});
	});

	describe('writeFileAtomic', () => {
		before(() => {
			spy(fs, 'rename');
		});

		after(() => {
			(fs.rename as SinonSpy).restore();
		});

		it('should write string data atomically', async () => {
			await fsUtils.writeFileAtomic(testFile1, 'foo baz');
			expect(await fs.readFile(testFile1, 'utf-8')).to.equal('foo baz');
			expect(fs.rename).to.have.been.calledWith(`${testFile1}.new`, testFile1);
		});

		it('should write buffer data atomically', async () => {
			await fsUtils.writeFileAtomic(testFile2, Buffer.from('baz foo'));
			expect(await fs.readFile(testFile2, 'utf-8')).to.equal('baz foo');
			expect(fs.rename).to.have.been.calledWith(`${testFile2}.new`, testFile2);
		});
	});

	describe('safeRename', () => {
		it('should rename a file', async () => {
			await fsUtils.safeRename(testFile1, testFile1 + 'rename');
			const dirContents = await fs.readdir(rootMountPoint);
			expect(dirContents).to.have.length(2);
			expect(dirContents).to.not.include(testFileName1);
			expect(dirContents).to.include(testFileName1 + 'rename');
		});

		it('should replace an existing file', async () => {
			await fsUtils.safeRename(testFile1, testFile2);
			const dirContents = await fs.readdir(rootMountPoint);
			expect(dirContents).to.have.length(1);
			expect(dirContents).to.include(testFileName2);
			expect(dirContents).to.not.include(testFileName1);
		});
	});

	describe('exists', () => {
		it('should return whether a file exists', async () => {
			expect(await fsUtils.exists(testFile1)).to.be.true;
			await fs.unlink(testFile1);
			expect(await fsUtils.exists(testFile1)).to.be.false;
		});
	});

	describe('pathExistsOnHost', () => {
		it('should return whether a file exists in host OS fs', async () => {
			expect(await fsUtils.pathExistsOnHost(testFileName1)).to.be.true;
			await fs.unlink(testFile1);
			expect(await fsUtils.pathExistsOnHost(testFileName1)).to.be.false;
		});
	});

	describe('mkdirp', () => {
		it('should recursively create directories', async () => {
			await fsUtils.mkdirp(
				path.join(rootMountPoint, 'test1', 'test2', 'test3'),
			);
			expect(() =>
				fs.readdir(path.join(rootMountPoint, 'test1', 'test2', 'test3')),
			).to.not.throw();
		});
	});

	describe('unlinkAll', () => {
		it('should unlink a single file', async () => {
			await fsUtils.unlinkAll(testFile1);
			expect(await fs.readdir(rootMountPoint)).to.not.include(testFileName1);
		});

		it('should unlink multiple files', async () => {
			await fsUtils.unlinkAll(testFile1, testFile2);
			expect(await fs.readdir(rootMountPoint)).to.have.length(0);
		});
	});

	describe('getPathOnHost', () => {
		it("should return the paths of one or more files as they exist on host OS's root", async () => {
			expect(fsUtils.getPathOnHost(testFileName1)).to.deep.equal([testFile1]);
			expect(
				fsUtils.getPathOnHost(...[testFileName1, testFileName2]),
			).to.deep.equal([testFile1, testFile2]);
		});
	});
});
