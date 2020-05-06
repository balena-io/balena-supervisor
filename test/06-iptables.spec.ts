import * as Bluebird from 'bluebird';
import { stub } from 'sinon';
import { expect } from './lib/chai-config';

import * as iptables from '../src/lib/iptables';

describe('iptables', async () => {
	it('calls iptables to delete and recreate rules to block a port', async () => {
		stub(iptables, 'execAsync').returns(Bluebird.resolve(''));

		await iptables.rejectOnAllInterfacesExcept(['foo', 'bar'], 42);
		expect((iptables.execAsync as sinon.SinonStub).callCount).to.equal(16);
		expect(iptables.execAsync).to.be.calledWith(
			'iptables -D INPUT -p tcp --dport 42 -i foo -j ACCEPT',
		);
		expect(iptables.execAsync).to.be.calledWith(
			'iptables -I INPUT -p tcp --dport 42 -i foo -j ACCEPT',
		);
		expect(iptables.execAsync).to.be.calledWith(
			'iptables -D INPUT -p tcp --dport 42 -i bar -j ACCEPT',
		);
		expect(iptables.execAsync).to.be.calledWith(
			'iptables -I INPUT -p tcp --dport 42 -i bar -j ACCEPT',
		);
		expect(iptables.execAsync).to.be.calledWith(
			'iptables -D OUTPUT -p tcp --sport 42 -m state --state ESTABLISHED -j ACCEPT',
		);
		expect(iptables.execAsync).to.be.calledWith(
			'iptables -A OUTPUT -p tcp --sport 42 -m state --state ESTABLISHED -j ACCEPT',
		);
		expect(iptables.execAsync).to.be.calledWith(
			'iptables -D INPUT -p tcp --dport 42 -j REJECT',
		);
		expect(iptables.execAsync).to.be.calledWith(
			'iptables -A INPUT -p tcp --dport 42 -j REJECT',
		);
		expect(iptables.execAsync).to.be.calledWith(
			'ip6tables -D INPUT -p tcp --dport 42 -i foo -j ACCEPT',
		);
		expect(iptables.execAsync).to.be.calledWith(
			'ip6tables -I INPUT -p tcp --dport 42 -i foo -j ACCEPT',
		);
		expect(iptables.execAsync).to.be.calledWith(
			'ip6tables -D INPUT -p tcp --dport 42 -i bar -j ACCEPT',
		);
		expect(iptables.execAsync).to.be.calledWith(
			'ip6tables -I INPUT -p tcp --dport 42 -i bar -j ACCEPT',
		);
		expect(iptables.execAsync).to.be.calledWith(
			'ip6tables -D OUTPUT -p tcp --sport 42 -m state --state ESTABLISHED -j ACCEPT',
		);
		expect(iptables.execAsync).to.be.calledWith(
			'ip6tables -A OUTPUT -p tcp --sport 42 -m state --state ESTABLISHED -j ACCEPT',
		);
		expect(iptables.execAsync).to.be.calledWith(
			'ip6tables -D INPUT -p tcp --dport 42 -j REJECT',
		);
		expect(iptables.execAsync).to.be.calledWith(
			'ip6tables -A INPUT -p tcp --dport 42 -j REJECT',
		);
		(iptables.execAsync as sinon.SinonStub).restore();
	});
});
