import type { ICredentialType, INodeProperties } from 'n8n-workflow';

export class RadwareApi implements ICredentialType {
	name = 'radwareApi';
	displayName = 'Radware API';

	// “Open docs” in the credential modal
	documentationUrl = 'https://github.com/<your-org>/<your-repo>#authentication';

	properties: INodeProperties[] = [
		{
			displayName: 'Context (API ID)',
			name: 'context',
			type: 'string',
			default: '',
			required: true,
			description: 'Your Radware Cloud account/tenant ID',
			hint: 'This is sent as the “Context” header.',
		},
		{
			displayName: 'x-api-key (API Key)',
			name: 'xApiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description: 'Your Radware API key',
			hint: 'This is sent as the “x-api-key” header.',
		},
	];

	authenticate = {
		type: 'generic' as const,
		properties: {
			headers: {
				'x-api-key': '={{$credentials.xApiKey}}',
				Context: '={{$credentials.context}}',
			},
		},
	};
}
