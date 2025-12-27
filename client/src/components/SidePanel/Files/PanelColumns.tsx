/* eslint-disable react-hooks/rules-of-hooks */
import { useCallback } from 'react';
import { useRecoilValue } from 'recoil';
import { ArrowUpDown, Download } from 'lucide-react';
import { Button, TooltipAnchor, useToastContext } from '@librechat/client';
import type { ColumnDef } from '@tanstack/react-table';
import type { TFile } from 'librechat-data-provider';
import PanelFileCell from './PanelFileCell';
import { useLocalize } from '~/hooks';
import { useFileDownload } from '~/data-provider/Files/queries';
import store from '~/store';
import { formatDate } from '~/utils';

function DownloadCell({ file }: { file: TFile | undefined }) {
  const localize = useLocalize();
  const user = useRecoilValue(store.user);
  const { showToast } = useToastContext();
  const { refetch: downloadFile } = useFileDownload(user?.id ?? '', file?.file_id);

  const handleDownload = useCallback(
    async (e: React.MouseEvent<HTMLButtonElement>) => {
      e.preventDefault();
      e.stopPropagation();

      if (!file?.file_id) {
        showToast({
          status: 'error',
          message: localize('com_ui_download_error'),
        });
        return;
      }

      try {
        const stream = await downloadFile();
        if (stream.data == null || stream.data === '') {
          console.error('Error downloading file: No data found');
          showToast({
            status: 'error',
            message: localize('com_ui_download_error'),
          });
          return;
        }
        const link = document.createElement('a');
        link.href = stream.data;
        link.setAttribute('download', file.filename ?? 'file');
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        window.URL.revokeObjectURL(stream.data);
      } catch (error) {
        console.error('Error downloading file:', error);
        showToast({
          status: 'error',
          message: localize('com_ui_download_error'),
        });
      }
    },
    [file?.file_id, file?.filename, downloadFile, localize, showToast],
  );

  if (!file?.file_id) {
    return null;
  }

  return (
    <TooltipAnchor
      description={localize('com_ui_download')}
      side="top"
      render={
        <Button
          variant="ghost"
          size="sm"
          onClick={handleDownload}
          className="h-6 w-6 p-0 hover:bg-surface-hover"
          aria-label={localize('com_ui_download')}
        >
          <Download className="h-3.5 w-3.5" />
        </Button>
      }
    />
  );
}

export const columns: ColumnDef<TFile | undefined>[] = [
  {
    accessorKey: 'filename',
    header: ({ column }) => {
      const localize = useLocalize();
      return (
        <Button
          variant="ghost"
          className="h-auto p-0 text-xs hover:bg-surface-hover"
          onClick={() => column.toggleSorting(column.getIsSorted() === 'asc')}
          aria-label={localize('com_ui_name')}
        >
          {localize('com_ui_name')}
          <ArrowUpDown className="ml-1 h-3 w-3" aria-hidden="true" />
        </Button>
      );
    },
    meta: {
      size: 'auto',
    },
    cell: ({ row }) => <PanelFileCell row={row} />,
  },
  {
    accessorKey: 'updatedAt',
    meta: {
      size: '100px',
    },
    header: ({ column }) => {
      const localize = useLocalize();
      return (
        <Button
          variant="ghost"
          className="h-auto p-0 text-xs hover:bg-surface-hover"
          onClick={() => column.toggleSorting(column.getIsSorted() === 'asc')}
          aria-label={localize('com_ui_date')}
        >
          {localize('com_ui_date')}
          <ArrowUpDown className="ml-1 h-3 w-3" />
        </Button>
      );
    },
    cell: ({ row }) => (
      <span className="flex justify-end text-xs text-text-secondary">
        {formatDate(row.original?.updatedAt?.toString() ?? '')}
      </span>
    ),
  },
  {
    id: 'download',
    size: 40,
    header: () => {
      return null; // Hide header text for download column to save space
    },
    cell: ({ row }) => {
      return <DownloadCell file={row.original} />;
    },
    enableSorting: false,
    enableHiding: false,
  },
];
