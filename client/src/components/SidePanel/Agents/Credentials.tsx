import React, { useCallback } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Controller, useFieldArray, useFormContext } from 'react-hook-form';
import type { AgentCredentialInput } from 'librechat-data-provider';
import type { AgentForm } from '~/common';
import { cn, defaultTextProps, removeFocusOutlines } from '~/utils';
import { useLocalize } from '~/hooks';

const inputClass = cn(
  defaultTextProps,
  'flex w-full px-3 py-2 border-border-light bg-surface-secondary focus-visible:ring-2 focus-visible:ring-ring-primary',
  removeFocusOutlines,
);

const labelClass = 'mb-1 block text-xs font-medium text-token-text-secondary';

const emptyCredential = (): AgentCredentialInput => ({
  origin: '',
  loginUrl: '',
  authType: 'basic_login',
  username: '',
  password: undefined,
  usernameSelector: '',
  passwordSelector: '',
  submitSelector: '',
  successSelector: '',
  enabled: true,
});

export default function Credentials() {
  const localize = useLocalize();
  const { control, setValue, watch } = useFormContext<AgentForm>();
  const { fields, append, remove } = useFieldArray({
    control,
    name: 'credentials',
  });
  const credentials = watch('credentials') ?? [];

  const addCredential = useCallback(() => {
    append(emptyCredential());
  }, [append]);

  return (
    <div className="mb-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <label className="text-token-text-primary block text-sm font-medium">
          {localize('com_agents_credentials')}
        </label>
        <button
          type="button"
          className="btn btn-neutral border-token-border-light h-8 rounded-lg px-3 text-sm font-medium"
          onClick={addCredential}
        >
          <Plus className="mr-1 h-4 w-4" aria-hidden="true" />
          {localize('com_agents_add_credential')}
        </button>
      </div>
      <div className="flex flex-col gap-3">
        {fields.map((field, index) => {
          const passwordSet = Boolean(credentials[index]?.passwordSet);
          return (
            <div key={field.id} className="rounded-md border border-border-light p-3">
              <div className="mb-3 flex items-start justify-between gap-2">
                <Controller
                  name={`credentials.${index}.label`}
                  control={control}
                  render={({ field: labelField }) => (
                    <div className="min-w-0 flex-1">
                      <label className={labelClass} htmlFor={`credential-label-${index}`}>
                        {localize('com_ui_label')}
                      </label>
                      <input
                        {...labelField}
                        id={`credential-label-${index}`}
                        value={labelField.value ?? ''}
                        className={inputClass}
                        placeholder={localize('com_agents_credential_label_placeholder')}
                      />
                    </div>
                  )}
                />
                <button
                  type="button"
                  className="mt-6 rounded-md p-2 text-text-secondary hover:bg-surface-tertiary hover:text-text-primary"
                  onClick={() => remove(index)}
                  aria-label={localize('com_ui_remove')}
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
              <div className="mb-3 grid grid-cols-1 gap-3">
                <Controller
                  name={`credentials.${index}.origin`}
                  control={control}
                  render={({ field: originField }) => (
                    <div>
                      <label className={labelClass} htmlFor={`credential-origin-${index}`}>
                        {localize('com_agents_credential_origin')}
                      </label>
                      <input
                        {...originField}
                        id={`credential-origin-${index}`}
                        value={originField.value ?? ''}
                        className={inputClass}
                        placeholder="https://app.example.com"
                      />
                    </div>
                  )}
                />
                <Controller
                  name={`credentials.${index}.loginUrl`}
                  control={control}
                  render={({ field: loginField }) => (
                    <div>
                      <label className={labelClass} htmlFor={`credential-login-url-${index}`}>
                        {localize('com_agents_credential_login_url')}
                      </label>
                      <input
                        {...loginField}
                        id={`credential-login-url-${index}`}
                        value={loginField.value ?? ''}
                        className={inputClass}
                        placeholder="https://app.example.com/login"
                      />
                    </div>
                  )}
                />
              </div>
              <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Controller
                  name={`credentials.${index}.username`}
                  control={control}
                  render={({ field: usernameField }) => (
                    <div>
                      <label className={labelClass} htmlFor={`credential-username-${index}`}>
                        {localize('com_agents_credential_username')}
                      </label>
                      <input
                        {...usernameField}
                        id={`credential-username-${index}`}
                        value={usernameField.value ?? ''}
                        className={inputClass}
                        autoComplete="off"
                      />
                    </div>
                  )}
                />
                <Controller
                  name={`credentials.${index}.password`}
                  control={control}
                  render={({ field: passwordField }) => (
                    <div>
                      <label className={labelClass} htmlFor={`credential-password-${index}`}>
                        {localize('com_agents_credential_password')}
                      </label>
                      <input
                        {...passwordField}
                        id={`credential-password-${index}`}
                        value={passwordField.value ?? ''}
                        className={inputClass}
                        type="password"
                        autoComplete="new-password"
                        placeholder={
                          passwordSet ? localize('com_agents_credential_password_saved') : ''
                        }
                      />
                    </div>
                  )}
                />
              </div>
              <details className="mb-3">
                <summary className="cursor-pointer text-sm text-text-secondary">
                  {localize('com_agents_credential_selectors')}
                </summary>
                <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {(
                    [
                      ['usernameSelector', 'com_agents_credential_username_selector'],
                      ['passwordSelector', 'com_agents_credential_password_selector'],
                      ['submitSelector', 'com_agents_credential_submit_selector'],
                      ['successSelector', 'com_agents_credential_success_selector'],
                    ] as const
                  ).map(([name, label]) => (
                    <Controller
                      key={name}
                      name={`credentials.${index}.${name}`}
                      control={control}
                      render={({ field: selectorField }) => (
                        <div>
                          <label className={labelClass} htmlFor={`credential-${name}-${index}`}>
                            {localize(label)}
                          </label>
                          <input
                            {...selectorField}
                            id={`credential-${name}-${index}`}
                            value={selectorField.value ?? ''}
                            className={inputClass}
                          />
                        </div>
                      )}
                    />
                  ))}
                </div>
              </details>
              <div className="flex items-center justify-between gap-2">
                <Controller
                  name={`credentials.${index}.enabled`}
                  control={control}
                  render={({ field: enabledField }) => (
                    <label className="flex items-center gap-2 text-sm text-text-secondary">
                      <input
                        type="checkbox"
                        checked={enabledField.value !== false}
                        onChange={(event) => enabledField.onChange(event.target.checked)}
                      />
                      {localize('com_ui_enabled')}
                    </label>
                  )}
                />
                {passwordSet && (
                  <button
                    type="button"
                    className="text-sm text-text-secondary hover:text-text-primary"
                    onClick={() =>
                      setValue(`credentials.${index}.password`, '', {
                        shouldDirty: true,
                      })
                    }
                  >
                    {localize('com_agents_credential_clear_password')}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
