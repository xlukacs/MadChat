import React, { useMemo, useState, useCallback } from 'react';
import { v4 } from 'uuid';
import { QueryKeys } from 'librechat-data-provider';
import { useQueryClient, InfiniteData } from '@tanstack/react-query';
import {
  Button,
  OGDialog,
  OGDialogClose,
  OGDialogTitle,
  OGDialogHeader,
  OGDialogContent,
  Spinner,
  useToastContext,
} from '@librechat/client';
import type { TConversation, ConversationListResponse } from 'librechat-data-provider';
import { useUpdateConversationMutation } from '~/data-provider';
import { useLocalize } from '~/hooks';
import { NotificationSeverity } from '~/common';

function getConversationsFromCache(
  queryClient: ReturnType<typeof useQueryClient>,
): TConversation[] {
  const conversationMap = new Map<string, TConversation>();
  const queries = queryClient
    .getQueryCache()
    .findAll([QueryKeys.allConversations], { exact: false });

  for (const query of queries) {
    const queryData = queryClient.getQueryData<InfiniteData<ConversationListResponse>>(
      query.queryKey,
    );
    if (!queryData?.pages) {
      continue;
    }

    for (const page of queryData.pages) {
      for (const conversation of page.conversations ?? []) {
        if (!conversation?.conversationId) {
          continue;
        }
        if (!conversationMap.has(conversation.conversationId)) {
          conversationMap.set(conversation.conversationId, conversation);
        }
      }
    }
  }

  return Array.from(conversationMap.values());
}

function getDescendants(conversations: TConversation[], conversationId: string): Set<string> {
  const childrenByParent = new Map<string, string[]>();
  const descendants = new Set<string>();

  for (const convo of conversations) {
    const parentId = convo.parentId ?? null;
    const childId = convo.conversationId ?? '';
    if (!parentId || !childId) {
      continue;
    }
    const children = childrenByParent.get(parentId) ?? [];
    children.push(childId);
    childrenByParent.set(parentId, children);
  }

  const stack = [...(childrenByParent.get(conversationId) ?? [])];
  while (stack.length > 0) {
    const childId = stack.pop();
    if (!childId || descendants.has(childId)) {
      continue;
    }
    descendants.add(childId);
    const children = childrenByParent.get(childId) ?? [];
    for (const nextChildId of children) {
      if (!descendants.has(nextChildId)) {
        stack.push(nextChildId);
      }
    }
  }

  return descendants;
}

type MoveToFolderButtonProps = {
  conversationId: string;
  triggerRef?: React.RefObject<HTMLButtonElement>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  setMenuOpen?: (open: boolean) => void;
};

type CreateFolderButtonProps = {
  conversationId: string;
  triggerRef?: React.RefObject<HTMLButtonElement>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  setMenuOpen?: (open: boolean) => void;
};

export function MoveToFolderButton({
  conversationId,
  triggerRef,
  open,
  onOpenChange,
  setMenuOpen,
}: MoveToFolderButtonProps) {
  const localize = useLocalize();
  const queryClient = useQueryClient();
  const { showToast } = useToastContext();
  const updateConversation = useUpdateConversationMutation(conversationId);
  const [search, setSearch] = useState('');
  const [selectedParentId, setSelectedParentId] = useState<string | null>(null);

  const allConversations = useMemo(() => getConversationsFromCache(queryClient), [queryClient]);
  const blockedIds = useMemo(() => {
    const descendants = getDescendants(allConversations, conversationId);
    descendants.add(conversationId);
    return descendants;
  }, [allConversations, conversationId]);

  const candidates = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    return allConversations
      .filter((convo) => convo.conversationId && !blockedIds.has(convo.conversationId))
      .filter((convo) => {
        if (!normalizedSearch) {
          return true;
        }
        const value = (convo.title ?? localize('com_ui_untitled')).toLowerCase();
        return value.includes(normalizedSearch);
      })
      .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  }, [allConversations, blockedIds, localize, search]);

  const onMove = useCallback(async () => {
    if (!selectedParentId) {
      return;
    }

    try {
      await updateConversation.mutateAsync({
        conversationId,
        parentId: selectedParentId,
      });
      await queryClient.invalidateQueries({
        queryKey: [QueryKeys.allConversations],
        exact: false,
      });
      showToast({
        message: localize('com_ui_move_to_folder_success'),
        severity: NotificationSeverity.SUCCESS,
        showIcon: true,
      });
      onOpenChange(false);
      setMenuOpen?.(false);
      setSearch('');
      setSelectedParentId(null);
    } catch (error) {
      void error;
      showToast({
        message: localize('com_ui_error_connection'),
        severity: NotificationSeverity.ERROR,
        showIcon: true,
      });
    }
  }, [
    conversationId,
    localize,
    onOpenChange,
    queryClient,
    selectedParentId,
    setMenuOpen,
    showToast,
    updateConversation,
  ]);

  return (
    <OGDialog open={open} onOpenChange={onOpenChange} triggerRef={triggerRef}>
      <OGDialogContent className="w-11/12 max-w-lg" showCloseButton={true}>
        <OGDialogHeader>
          <OGDialogTitle>{localize('com_ui_move_to_folder')}</OGDialogTitle>
        </OGDialogHeader>
        <div className="space-y-3">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={localize('com_ui_search')}
            className="w-full rounded-md border border-border-medium bg-surface-primary px-3 py-2 text-sm outline-none ring-0 focus-visible:ring-2 focus-visible:ring-ring-primary"
          />
          <div className="max-h-64 space-y-1 overflow-y-auto rounded-md border border-border-medium p-1">
            {candidates.length === 0 ? (
              <div className="px-2 py-3 text-sm text-text-secondary">
                {localize('com_ui_no_folders_found')}
              </div>
            ) : (
              candidates.map((convo) => {
                const id = convo.conversationId ?? '';
                const selected = selectedParentId === id;
                return (
                  <button
                    key={id}
                    type="button"
                    className={`flex w-full items-center justify-between rounded-md px-2 py-2 text-left text-sm ${
                      selected
                        ? 'bg-surface-active-alt text-text-primary'
                        : 'hover:bg-surface-hover'
                    }`}
                    onClick={() => setSelectedParentId(id)}
                  >
                    <span className="truncate">{convo.title || localize('com_ui_untitled')}</span>
                    {selected ? (
                      <span className="text-xs text-text-secondary">
                        {localize('com_ui_selected')}
                      </span>
                    ) : null}
                  </button>
                );
              })
            )}
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-4">
          <OGDialogClose asChild>
            <Button variant="outline">{localize('com_ui_cancel')}</Button>
          </OGDialogClose>
          <Button onClick={onMove} disabled={!selectedParentId || updateConversation.isLoading}>
            {updateConversation.isLoading ? (
              <Spinner className="size-4" />
            ) : (
              localize('com_ui_move')
            )}
          </Button>
        </div>
      </OGDialogContent>
    </OGDialog>
  );
}

export function CreateFolderButton({
  conversationId,
  triggerRef,
  open,
  onOpenChange,
  setMenuOpen,
}: CreateFolderButtonProps) {
  const localize = useLocalize();
  const queryClient = useQueryClient();
  const { showToast } = useToastContext();
  const updateConversation = useUpdateConversationMutation(conversationId);
  const [folderName, setFolderName] = useState('');

  const onCreateFolder = useCallback(async () => {
    const sanitizedFolderName = folderName.trim();
    if (!sanitizedFolderName) {
      return;
    }

    const folderConversationId = v4();
    try {
      await updateConversation.mutateAsync({
        conversationId: folderConversationId,
        title: sanitizedFolderName,
      });
      await updateConversation.mutateAsync({
        conversationId,
        parentId: folderConversationId,
      });
      await queryClient.invalidateQueries({
        queryKey: [QueryKeys.allConversations],
        exact: false,
      });
      showToast({
        message: localize('com_ui_create_folder_success'),
        severity: NotificationSeverity.SUCCESS,
        showIcon: true,
      });
      setFolderName('');
      onOpenChange(false);
      setMenuOpen?.(false);
    } catch (error) {
      void error;
      showToast({
        message: localize('com_ui_error_connection'),
        severity: NotificationSeverity.ERROR,
        showIcon: true,
      });
    }
  }, [
    conversationId,
    folderName,
    localize,
    onOpenChange,
    queryClient,
    setMenuOpen,
    showToast,
    updateConversation,
  ]);

  return (
    <OGDialog open={open} onOpenChange={onOpenChange} triggerRef={triggerRef}>
      <OGDialogContent className="w-11/12 max-w-md" showCloseButton={true}>
        <OGDialogHeader>
          <OGDialogTitle>{localize('com_ui_create_folder')}</OGDialogTitle>
        </OGDialogHeader>
        <div className="space-y-2">
          <label htmlFor="folder-name" className="text-sm font-medium text-text-primary">
            {localize('com_ui_name')}
          </label>
          <input
            id="folder-name"
            type="text"
            value={folderName}
            onChange={(e) => setFolderName(e.target.value)}
            placeholder={localize('com_ui_folder_name')}
            className="w-full rounded-md border border-border-medium bg-surface-primary px-3 py-2 text-sm outline-none ring-0 focus-visible:ring-2 focus-visible:ring-ring-primary"
          />
        </div>
        <div className="flex justify-end gap-2 pt-4">
          <OGDialogClose asChild>
            <Button variant="outline">{localize('com_ui_cancel')}</Button>
          </OGDialogClose>
          <Button
            onClick={onCreateFolder}
            disabled={!folderName.trim() || updateConversation.isLoading}
          >
            {updateConversation.isLoading ? (
              <Spinner className="size-4" />
            ) : (
              localize('com_ui_create')
            )}
          </Button>
        </div>
      </OGDialogContent>
    </OGDialog>
  );
}
