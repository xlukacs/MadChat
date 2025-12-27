import { useCallback } from 'react';
import { useRecoilValue } from 'recoil';
import { Download } from 'lucide-react';
import type { TFile } from 'librechat-data-provider';
import { useFileDownload } from '~/data-provider/Files/queries';
import { useToastContext } from '@librechat/client';
import { useLocalize } from '~/hooks';
import store from '~/store';
import type { ExtendedFile } from '~/common';

export default function DownloadFile({ file }: { file: Partial<ExtendedFile | TFile> }) {
  const localize = useLocalize();
  const user = useRecoilValue(store.user);
  const { showToast } = useToastContext();
  const { refetch: downloadFile } = useFileDownload(user?.id ?? '', file.file_id);

  const handleDownload = useCallback(
    async (e: React.MouseEvent<HTMLButtonElement>) => {
      e.preventDefault();
      e.stopPropagation();

      if (!file.file_id) {
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
    [file.file_id, file.filename, downloadFile, localize, showToast],
  );

  // Only show download button if file has file_id and is fully uploaded
  if (!file.file_id || (file as ExtendedFile).progress !== undefined && (file as ExtendedFile).progress < 1) {
    return null;
  }

  return (
    <button
      type="button"
      className="absolute left-1 top-1 -translate-y-1/2 -translate-x-1/2 rounded-full bg-surface-secondary p-0.5 transition-colors duration-200 hover:bg-surface-primary"
      onClick={handleDownload}
      aria-label={localize('com_ui_download')}
    >
      <Download className="h-3 w-3" aria-hidden="true" />
    </button>
  );
}

