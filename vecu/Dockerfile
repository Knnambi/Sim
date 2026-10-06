# Image for the CAN side: BCM vECU, CAN provider and CAN monitor.
FROM python:3.12-slim
WORKDIR /vecu
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY *.py ./
COPY dbc ./dbc
COPY mapping ./mapping
ENV PYTHONUNBUFFERED=1
ENTRYPOINT ["python"]
CMD ["bcm.py"]
